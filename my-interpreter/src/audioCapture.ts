import type { CaptureMode } from './types';

const DESKTOP_NO_AUDIO_MESSAGE =
  'No audio in shared tab. Stop and start again: when the browser asks what to share, choose the Teams tab and check "Share tab audio" (or "Share system audio") so the app can hear the meeting.';

const SAMPLE_RATE_CAPTURE = 48000;
const SAMPLE_RATE_TARGET = 16000;
const DOWN_RATIO = SAMPLE_RATE_CAPTURE / SAMPLE_RATE_TARGET; // 3

// Worklet sends ~85ms frames (4096 samples at 48kHz).
const FRAME_SAMPLES = 4096;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE_CAPTURE) * 1000; // ≈ 85 ms

// ---------------------------------------------------------------------------
// Pause-detection settings
// A real interpreter waits for a natural pause before speaking.
// We do the same: accumulate audio until the speaker pauses, then send.
// ---------------------------------------------------------------------------
const SILENCE_RMS       = 0.008;  // RMS below this = silence / background noise
const PAUSE_GAP_MS      = 1200;   // speaker silent for 1.2 s = end of utterance
const MIN_SPEECH_MS     = 1500;   // ignore clips shorter than 1.5 s (noise blip)
const MAX_SPEECH_MS     = 20000;  // force-send after 20 s even without a pause

const PAUSE_FRAMES_NEEDED = Math.ceil(PAUSE_GAP_MS / FRAME_MS);   // ~14 frames
const MAX_SPEECH_FRAMES   = Math.ceil(MAX_SPEECH_MS / FRAME_MS);  // ~235 frames
const MIN_SPEECH_FRAMES   = Math.ceil(MIN_SPEECH_MS / FRAME_MS);  //  ~18 frames

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

function floatTo16BitPcm(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function downsampleTo16khz(int16At48k: Int16Array): Int16Array {
  const outLen = Math.floor(int16At48k.length / DOWN_RATIO);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * DOWN_RATIO;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const a = int16At48k[idx] ?? 0;
    const b = int16At48k[Math.min(idx + 1, int16At48k.length - 1)] ?? 0;
    out[i] = Math.round(a + frac * (b - a));
  }
  return out;
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
 * State machine:
 *   IDLE     → speaker silent; discard frames
 *   SPEAKING → speaker active; accumulate frames
 *              – after PAUSE_GAP_MS of silence  → flush to Gemini → IDLE
 *              – after MAX_SPEECH_MS total       → flush to Gemini → IDLE
 */
export async function captureAudioChunks(
  stream: MediaStream,
  onChunk: ChunkCallback
): Promise<() => void> {
  if (stream.getAudioTracks().length === 0) throw new Error(DESKTOP_NO_AUDIO_MESSAGE);

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
  let silenceFrameCount = 0;

  function flush() {
    if (speechFrames.length < MIN_SPEECH_FRAMES) {
      // Too short — likely noise, not real speech
      speechFrames = [];
      silenceFrameCount = 0;
      state = 'idle';
      return;
    }
    const pcm = concatenateInt16(speechFrames);
    speechFrames = [];
    silenceFrameCount = 0;
    state = 'idle';
    onChunk(pcm.buffer.slice(0) as ArrayBuffer);
  }

  node.port.onmessage = (e: MessageEvent<{ frame: Float32Array }>) => {
    if (stopped) return;

    const int16_16k = downsampleTo16khz(floatTo16BitPcm(e.data.frame));
    const silent = rmsEnergy(int16_16k) < SILENCE_RMS;

    if (state === 'idle') {
      if (!silent) {
        state = 'speaking';
        speechFrames.push(int16_16k);
        silenceFrameCount = 0;
      }
      // drop silent frames while idle
    } else {
      // state === 'speaking'
      speechFrames.push(int16_16k);

      if (silent) {
        silenceFrameCount++;
        if (silenceFrameCount >= PAUSE_FRAMES_NEEDED) {
          flush(); // natural pause detected — interpret this utterance
        }
      } else {
        silenceFrameCount = 0;
        if (speechFrames.length >= MAX_SPEECH_FRAMES) {
          flush(); // speaker went on too long — send what we have
        }
      }
    }
  };

  source.connect(node);
  node.connect(audioContext.destination);

  const stop = () => {
    stopped = true;
    if (state === 'speaking' && speechFrames.length >= MIN_SPEECH_FRAMES) {
      flush(); // send any remaining speech when user stops
    }
    try { node.disconnect(); source.disconnect(); audioContext.close(); } catch (_) {}
  };

  stream.getTracks().forEach((t) => t.addEventListener('ended', stop, { once: true }));
  return stop;
}
