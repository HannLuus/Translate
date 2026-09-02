import { floatTo16BitPcm, downsampleTo16khz, SAMPLE_RATE_TARGET } from './audioCapture';

const SAMPLE_RATE_CAPTURE = 48000;
const FRAME_SAMPLES = 4096;
const MIN_RECORDING_SAMPLES = SAMPLE_RATE_TARGET * 2; // ~2 seconds

const WORKLET_URL = new URL(
  `${import.meta.env.BASE_URL}audio-processor.worklet.js`,
  import.meta.url,
).href;

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

function pcm16ToWav(pcm16: Int16Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataSize, true);
  new Uint8Array(buf).set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), 44);

  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Record tab/window audio using the same AudioWorklet path as live desktop capture.
 * Avoids MediaRecorder, which often fails on browser display-capture streams.
 */
export async function startMeetingRecording(stream: MediaStream): Promise<{
  stop: () => Promise<File>;
}> {
  if (stream.getAudioTracks().length === 0) {
    throw new Error(
      'No audio in shared tab. Choose the Teams tab and check "Share tab audio" when starting.',
    );
  }

  const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_CAPTURE });
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch {
      /* may resume on user gesture */
    }
  }
  await audioContext.audioWorklet.addModule(WORKLET_URL);

  const source = audioContext.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioContext, 'capture-processor', {
    processorOptions: { frameSize: FRAME_SAMPLES },
  });

  const frames: Int16Array[] = [];
  let stopped = false;

  node.port.onmessage = (event: MessageEvent<{ frame: Float32Array }>) => {
    if (stopped) return;
    const pcm16k = downsampleTo16khz(floatTo16BitPcm(event.data.frame), SAMPLE_RATE_CAPTURE);
    frames.push(pcm16k);
  };

  source.connect(node);

  const stop = async (): Promise<File> => {
    if (stopped) {
      throw new Error('Recording already stopped.');
    }
    stopped = true;

    try {
      node.disconnect();
      source.disconnect();
      await audioContext.close();
    } catch {
      /* ignore teardown errors */
    }

    const pcm = concatenateInt16(frames);
    if (pcm.length < MIN_RECORDING_SAMPLES) {
      throw new Error(
        'Recording is empty or too short. When sharing, choose the Teams tab and check "Share tab audio".',
      );
    }

    const wav = pcm16ToWav(pcm, SAMPLE_RATE_TARGET);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    return new File([wav], `meeting-recording-${stamp}.wav`, { type: 'audio/wav' });
  };

  return { stop };
}
