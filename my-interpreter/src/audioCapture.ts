import type { CaptureMode } from './types';

const SAMPLE_RATE_CAPTURE = 48000; // typical from getUserMedia/getDisplayMedia
const SAMPLE_RATE_TARGET = 16000; // Speech-to-Text expects 16kHz
const CHUNK_DURATION_MS = 1500; // 1.5 s buffer for low-latency live interpretation
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

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url
).href;

export async function captureAudioChunks(
  stream: MediaStream,
  onChunk: ChunkCallback
): Promise<() => void> {
  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_CAPTURE });
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const samplesPerChunk = Math.floor(
    (SAMPLE_RATE_CAPTURE * CHUNK_DURATION_MS) / 1000
  );
  const node = new AudioWorkletNode(audioContext, 'capture-processor', {
    processorOptions: { chunkSize: samplesPerChunk },
  });

  let stopped = false;
  node.port.onmessage = (e: MessageEvent<{ chunk: Float32Array }>) => {
    if (stopped) return;
    const float32 = e.data.chunk;
    const int16_48k = floatTo16BitPcm(float32);
    const int16_16k = downsampleTo16khz(int16_48k);
    onChunk(int16_16k.buffer.slice(0) as ArrayBuffer);
  };

  source.connect(node);
  node.connect(audioContext.destination);

  const stop = () => {
    stopped = true;
    try {
      node.disconnect();
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
