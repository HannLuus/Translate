import type { CaptureMode } from './types';

const SAMPLE_RATE_CAPTURE = 48000; // typical from getUserMedia/getDisplayMedia
const SAMPLE_RATE_TARGET = 16000; // Speech-to-Text expects 16kHz
const CHUNK_DURATION_MS = 4000; // 4 seconds
const DOWN_RATIO = SAMPLE_RATE_CAPTURE / SAMPLE_RATE_TARGET; // 3

export async function getCaptureStream(
  mode: CaptureMode,
  loopbackDeviceId?: string
): Promise<MediaStream> {
  if (mode === 'desktop') {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    return stream;
  }
  if (mode === 'rooted_android' && loopbackDeviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: loopbackDeviceId } },
    });
    return stream;
  }
  // face_to_face or fallback
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  return stream;
}

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

export interface ChunkCallback {
  (pcm16khz: ArrayBuffer): void;
}

export function captureAudioChunks(
  stream: MediaStream,
  onChunk: ChunkCallback
): () => void {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_CAPTURE });
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  const source = audioContext.createMediaStreamSource(stream);
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const samplesPerChunk = Math.floor(
    (SAMPLE_RATE_CAPTURE * CHUNK_DURATION_MS) / 1000
  );
  let buffer: number[] = [];
  let stopped = false;

  processor.onaudioprocess = (e) => {
    if (stopped) return;
    const input = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) buffer.push(input[i]);
    while (buffer.length >= samplesPerChunk) {
      const chunk = buffer.splice(0, samplesPerChunk);
      const float32 = new Float32Array(chunk);
      const int16_48k = floatTo16BitPcm(float32);
      const int16_16k = downsampleTo16khz(int16_48k);
      onChunk(int16_16k.buffer.slice(0) as ArrayBuffer);
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  const stop = () => {
    stopped = true;
    try {
      processor.disconnect();
      source.disconnect();
      audioContext.close();
    } catch (_) {
      // ignore
    }
  };

  stream.getTracks().forEach((t) =>
    t.addEventListener('ended', stop, { once: true })
  );

  return stop;
}
