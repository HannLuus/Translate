import type { CaptureMode } from './types';

const DESKTOP_NO_AUDIO_MESSAGE =
  'No audio in shared tab. Stop and start again: when the browser asks what to share, choose the Teams tab and check "Share tab audio" (or "Share system audio") so the app can hear the meeting.';

export const SAMPLE_RATE_TARGET = 16000;

const SAMPLE_RATE_CAPTURE = 48000;

// Worklet sends ~85ms frames (4096 samples at 48kHz).
const FRAME_SAMPLES = 4096;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE_CAPTURE) * 1000; // ≈ 85 ms

/** Default rolling segment length for batch interpretation (~1 minute). Shorter segments
 *  process faster (less STT/MT work) so the queue keeps up with live speech while still
 *  maintaining ~3 min lag via queued segments. */
export const SEGMENT_MS = 60_000;
/** Audio overlap carried into the next segment so boundaries are not lost. */
export const SEGMENT_OVERLAP_MS = 5_000;
/** Emit a shorter final segment on stop if at least this much speech was buffered. */
const MIN_FINAL_SEGMENT_MS = 5_000;

const MIN_FINAL_FRAMES = Math.ceil(MIN_FINAL_SEGMENT_MS / FRAME_MS);

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

export function floatTo16BitPcm(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

/** Downsample 16-bit PCM to 16 kHz mono (required by edge functions / Speech API). */
export function downsampleTo16khz(int16AtSrcRate: Int16Array, srcSampleRate: number): Int16Array {
  if (srcSampleRate <= SAMPLE_RATE_TARGET) {
    return int16AtSrcRate;
  }
  const ratio = srcSampleRate / SAMPLE_RATE_TARGET;
  const outLen = Math.floor(int16AtSrcRate.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const a = int16AtSrcRate[idx] ?? 0;
    const b = int16AtSrcRate[Math.min(idx + 1, int16AtSrcRate.length - 1)] ?? 0;
    out[i] = Math.round(a + frac * (b - a));
  }
  return out;
}

function downsampleFrom48k(int16At48k: Int16Array): Int16Array {
  return downsampleTo16khz(int16At48k, SAMPLE_RATE_CAPTURE);
}

function concatenateInt16(arrays: Int16Array[]): Int16Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function tailFrames(frames: Int16Array[], count: number): Int16Array[] {
  if (count <= 0 || frames.length === 0) return [];
  return frames.slice(Math.max(0, frames.length - count));
}

// ---------------------------------------------------------------------------
// Stream capture
// ---------------------------------------------------------------------------

export async function getCaptureStream(
  mode: CaptureMode,
  loopbackDeviceId?: string
): Promise<MediaStream> {
  if (mode === 'desktop') {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(DESKTOP_NO_AUDIO_MESSAGE);
    }
    return stream;
  }
  if (mode === 'rooted_android' && loopbackDeviceId) {
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: loopbackDeviceId } },
    });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export interface SegmentCallback {
  (pcm16khz: ArrayBuffer, meta: { segmentIndex: number; durationMs: number }): void;
}

export type CaptureStallReason = 'track_ended' | 'audio_context_suspended';

export interface CaptureSegmentOptions {
  segmentMs?: number;
  overlapMs?: number;
  onStall?: (reason: CaptureStallReason) => void;
}

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url
).href;

/**
 * Continuous capture that closes rolling ~3-minute PCM segments with overlap.
 * Capture keeps running while prior segments are translated.
 */
export async function captureAudioSegments(
  stream: MediaStream,
  onSegment: SegmentCallback,
  options: CaptureSegmentOptions = {},
): Promise<() => void> {
  if (stream.getAudioTracks().length === 0) throw new Error(DESKTOP_NO_AUDIO_MESSAGE);

  const segmentFrames = Math.ceil((options.segmentMs ?? SEGMENT_MS) / FRAME_MS);
  const overlapFrames = Math.ceil((options.overlapMs ?? SEGMENT_OVERLAP_MS) / FRAME_MS);

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_CAPTURE });
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch {
      /* ignore — may resume on user gesture */
    }
  }
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'capture-processor', {
    processorOptions: { frameSize: FRAME_SAMPLES },
  });

  let stopped = false;
  let stalled = false;
  let frames: Int16Array[] = [];
  let segmentIndex = 0;

  function emitSegment(closingFrames: Int16Array[], keepOverlap: boolean) {
    if (closingFrames.length === 0) return;
    const pcm = concatenateInt16(closingFrames);
    const durationMs = Math.round((pcm.length / SAMPLE_RATE_TARGET) * 1000);
    const index = ++segmentIndex;
    if (keepOverlap) {
      frames = tailFrames(closingFrames, overlapFrames);
    } else {
      frames = [];
    }
    onSegment(pcm.buffer.slice(0) as ArrayBuffer, { segmentIndex: index, durationMs });
  }

  function notifyStall(reason: CaptureStallReason) {
    if (stopped || stalled) return;
    stalled = true;
    options.onStall?.(reason);
  }

  node.port.onmessage = (e: MessageEvent<{ frame: Float32Array }>) => {
    if (stopped || stalled) return;

    const int16_16k = downsampleFrom48k(floatTo16BitPcm(e.data.frame));
    frames.push(int16_16k);

    if (frames.length >= segmentFrames) {
      emitSegment(frames, true);
    }
  };

  // Avoid feeding mic into speakers (feedback risk); worklet still receives via port.
  source.connect(node);

  const onContextState = () => {
    if (audioContext.state === 'suspended') {
      notifyStall('audio_context_suspended');
    }
  };
  audioContext.addEventListener('statechange', onContextState);

  const onTrackEnded = () => notifyStall('track_ended');
  stream.getTracks().forEach((t) => t.addEventListener('ended', onTrackEnded, { once: true }));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frames.length >= MIN_FINAL_FRAMES) {
      emitSegment(frames, false);
    } else {
      frames = [];
    }
    try {
      audioContext.removeEventListener('statechange', onContextState);
      node.disconnect();
      source.disconnect();
      void audioContext.close();
    } catch {
      /* ignore teardown errors */
    }
  };

  return stop;
}

/** @deprecated Prefer captureAudioSegments for meeting interpretation. Kept for short reply capture if needed. */
export async function captureAudioChunks(
  stream: MediaStream,
  onChunk: (pcm16khz: ArrayBuffer) => void,
): Promise<() => void> {
  // Thin wrapper: emit ~20s max chunks without pause VAD (simple time slices).
  return captureAudioSegments(
    stream,
    (pcm) => onChunk(pcm),
    { segmentMs: 20_000, overlapMs: 350 },
  );
}
