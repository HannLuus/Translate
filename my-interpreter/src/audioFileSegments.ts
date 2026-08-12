import {
  floatTo16BitPcm,
  SAMPLE_RATE_TARGET,
  SEGMENT_MS,
  SEGMENT_OVERLAP_MS,
  MIN_FINAL_SEGMENT_MS,
  type SegmentCallback,
} from './audioCapture';

/** Practical desktop-friendly warning threshold for very long uploads. */
export const LONG_UPLOAD_WARN_MS = 2 * 60 * 60 * 1000;

export interface DecodeFileSegmentOptions {
  segmentMs?: number;
  overlapMs?: number;
  signal?: AbortSignal;
  /** Called once after decode with total duration (ms). */
  onDecoded?: (info: { durationMs: number; estimatedSegments: number }) => void;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Upload cancelled', 'AbortError');
  }
}

function mixToMono(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const mono = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: 1,
    sampleRate: buffer.sampleRate,
  });
  const out = mono.getChannelData(0);
  const nCh = buffer.numberOfChannels;
  for (let i = 0; i < buffer.length; i++) {
    let sum = 0;
    for (let c = 0; c < nCh; c++) sum += buffer.getChannelData(c)[i] ?? 0;
    out[i] = sum / nCh;
  }
  return mono;
}

/**
 * Decode a browser-supported audio file to 16 kHz mono Int16 PCM via Web Audio,
 * then emit overlapping segments matching live capture timing.
 */
export async function decodeAudioFileToSegments(
  file: File,
  onSegment: SegmentCallback,
  options: DecodeFileSegmentOptions = {},
): Promise<{ durationMs: number; segmentCount: number }> {
  const segmentMs = options.segmentMs ?? SEGMENT_MS;
  const overlapMs = options.overlapMs ?? SEGMENT_OVERLAP_MS;
  const signal = options.signal;

  throwIfAborted(signal);

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new Error('Could not read this file. Try MP3, WAV, M4A, or WebM.');
  }
  throwIfAborted(signal);

  const audioContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    // slice() so decodeAudioData can detach without affecting other readers
    decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('Could not decode this file. Try MP3, WAV, M4A, or WebM.');
  } finally {
    try {
      await audioContext.close();
    } catch {
      /* ignore */
    }
  }
  throwIfAborted(signal);

  if (decoded.length === 0 || decoded.duration <= 0) {
    throw new Error('This audio file appears empty.');
  }

  const durationMs = Math.round(decoded.duration * 1000);
  const stepMs = Math.max(1, segmentMs - overlapMs);
  const estimatedSegments = Math.max(1, Math.ceil(Math.max(0, durationMs - overlapMs) / stepMs));
  options.onDecoded?.({ durationMs, estimatedSegments });

  const mono = mixToMono(decoded);
  const targetFrames = Math.max(1, Math.ceil(mono.duration * SAMPLE_RATE_TARGET));
  const offline = new OfflineAudioContext(1, targetFrames, SAMPLE_RATE_TARGET);
  const source = offline.createBufferSource();
  source.buffer = mono;
  source.connect(offline.destination);
  source.start(0);

  let rendered: AudioBuffer;
  try {
    rendered = await offline.startRendering();
  } catch {
    throw new Error('Could not resample this audio file. Try MP3, WAV, M4A, or WebM.');
  }
  throwIfAborted(signal);

  const pcmAll = floatTo16BitPcm(rendered.getChannelData(0));
  const samplesPerSegment = Math.max(1, Math.round((segmentMs / 1000) * SAMPLE_RATE_TARGET));
  const samplesPerOverlap = Math.max(0, Math.round((overlapMs / 1000) * SAMPLE_RATE_TARGET));
  const stepSamples = Math.max(1, samplesPerSegment - samplesPerOverlap);
  const minFinalSamples = Math.max(1, Math.round((MIN_FINAL_SEGMENT_MS / 1000) * SAMPLE_RATE_TARGET));

  let segmentIndex = 0;
  let offset = 0;

  while (offset < pcmAll.length) {
    throwIfAborted(signal);
    const remaining = pcmAll.length - offset;
    const isLast = offset + samplesPerSegment >= pcmAll.length;
    const take = isLast ? remaining : samplesPerSegment;

    if (isLast && take < minFinalSamples && segmentIndex > 0) {
      break;
    }
    if (take <= 0) break;

    const slice = pcmAll.subarray(offset, offset + take);
    const copy = new Int16Array(slice.length);
    copy.set(slice);
    const segDurationMs = Math.round((copy.length / SAMPLE_RATE_TARGET) * 1000);
    segmentIndex += 1;
    onSegment(copy.buffer.slice(0) as ArrayBuffer, {
      segmentIndex,
      durationMs: segDurationMs,
    });

    if (isLast) break;
    offset += stepSamples;
  }

  if (segmentIndex === 0) {
    throw new Error('Recording is too short to process (need at least a few seconds of audio).');
  }

  return { durationMs, segmentCount: segmentIndex };
}
