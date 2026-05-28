import type { CaptureMode } from './types';

const DESKTOP_NO_AUDIO_MESSAGE =
  'No audio in shared tab. Stop and start again: when the browser asks what to share, choose the Teams tab and check "Share tab audio" (or "Share system audio") so the app can hear the meeting.';

export const SAMPLE_RATE_TARGET = 16000;

const SAMPLE_RATE_CAPTURE = 48000;

// Worklet sends ~85ms frames (4096 samples at 48kHz).
const FRAME_SAMPLES = 4096;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE_CAPTURE) * 1000; // ≈ 85 ms

// ---------------------------------------------------------------------------
// Segmentation settings
// ---------------------------------------------------------------------------
const MIN_SILENCE_RMS = 0.012;
const NOISE_FLOOR_ALPHA = 0.08;
const SPEECH_MULTIPLIER = 3.5;
const SPEECH_MARGIN = 0.006;

const PAUSE_GAP_MS = 600;
const MIN_SPEECH_MS = 800;
const MAX_SPEECH_MS = 20000;
/** Overlap tail prepended to next chunk to avoid word loss at boundaries. */
const OVERLAP_MS = 350;

const PAUSE_FRAMES_NEEDED = Math.ceil(PAUSE_GAP_MS / FRAME_MS);
const MAX_SPEECH_FRAMES = Math.ceil(MAX_SPEECH_MS / FRAME_MS);
const MIN_SPEECH_FRAMES = Math.ceil(MIN_SPEECH_MS / FRAME_MS);
const OVERLAP_FRAMES = Math.max(2, Math.ceil(OVERLAP_MS / FRAME_MS));

// Feature flags (localStorage overrides for rollout testing)
const FLAG_ADAPTIVE_VAD = 'interpreter-adaptive-vad';
const FLAG_OVERLAP_CHUNKS = 'interpreter-overlap-chunks';

function isFlagEnabled(key: string, defaultOn = true): boolean {
  const stored = localStorage.getItem(key);
  if (stored === '0') return false;
  if (stored === '1') return true;
  return defaultOn;
}

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

function rmsEnergy(int16: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / int16.length);
}

function concatenateInt16(arrays: Int16Array[]): Int16Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
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

export interface ChunkCallback {
  (pcm16khz: ArrayBuffer): void;
}

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url
).href;

/**
 * Capture audio and fire `onChunk` at natural speech pauses.
 *
 * Adaptive VAD: rolling noise floor + speech multiplier threshold.
 * Overlap: keep tail frames and prepend to next utterance.
 */
export async function captureAudioChunks(
  stream: MediaStream,
  onChunk: ChunkCallback
): Promise<() => void> {
  if (stream.getAudioTracks().length === 0) throw new Error(DESKTOP_NO_AUDIO_MESSAGE);

  const adaptiveVad = isFlagEnabled(FLAG_ADAPTIVE_VAD, true);
  const overlapChunks = isFlagEnabled(FLAG_OVERLAP_CHUNKS, true);

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_CAPTURE });
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'capture-processor', {
    processorOptions: { frameSize: FRAME_SAMPLES },
  });

  let stopped = false;
  let state: 'idle' | 'speaking' = 'idle';
  let speechFrames: Int16Array[] = [];
  let overlapPrefix: Int16Array[] = [];
  let silenceFrameCount = 0;
  let noiseFloor = MIN_SILENCE_RMS;

  function speechThreshold(): number {
    if (!adaptiveVad) return MIN_SILENCE_RMS;
    return Math.max(MIN_SILENCE_RMS, noiseFloor * SPEECH_MULTIPLIER + SPEECH_MARGIN);
  }

  function updateNoiseFloor(rms: number, isSilent: boolean): void {
    if (!adaptiveVad || !isSilent) return;
    noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA;
  }

  function flush() {
    if (speechFrames.length < MIN_SPEECH_FRAMES) {
      speechFrames = [];
      silenceFrameCount = 0;
      state = 'idle';
      return;
    }

    const pcm = concatenateInt16(speechFrames);
    overlapPrefix = overlapChunks ? tailFrames(speechFrames, OVERLAP_FRAMES) : [];
    speechFrames = [];
    silenceFrameCount = 0;
    state = 'idle';
    onChunk(pcm.buffer.slice(0) as ArrayBuffer);
  }

  node.port.onmessage = (e: MessageEvent<{ frame: Float32Array }>) => {
    if (stopped) return;

    const int16_16k = downsampleFrom48k(floatTo16BitPcm(e.data.frame));
    const rms = rmsEnergy(int16_16k);
    const threshold = speechThreshold();
    const silent = rms < threshold;
    updateNoiseFloor(rms, silent);

    if (state === 'idle') {
      if (!silent) {
        state = 'speaking';
        if (overlapPrefix.length > 0) {
          speechFrames = [...overlapPrefix, int16_16k];
          overlapPrefix = [];
        } else {
          speechFrames.push(int16_16k);
        }
        silenceFrameCount = 0;
      }
    } else {
      speechFrames.push(int16_16k);

      if (silent) {
        silenceFrameCount++;
        if (silenceFrameCount >= PAUSE_FRAMES_NEEDED) {
          flush();
        }
      } else {
        silenceFrameCount = 0;
        if (speechFrames.length >= MAX_SPEECH_FRAMES) {
          flush();
        }
      }
    }
  };

  source.connect(node);
  node.connect(audioContext.destination);

  const stop = () => {
    stopped = true;
    if (state === 'speaking' && speechFrames.length >= MIN_SPEECH_FRAMES) {
      flush();
    }
    try { node.disconnect(); source.disconnect(); audioContext.close(); } catch (_) {}
  };

  stream.getTracks().forEach((t) => t.addEventListener('ended', stop, { once: true }));
  return stop;
}
