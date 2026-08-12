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

/** Above this size, decode MP3 in smaller batches to avoid browser OOM. */
const CHUNKED_MP3_BYTES = 50 * 1024 * 1024;

/** Target audio duration per MP3 decode batch (~5 min keeps memory low). */
const MP3_DECODE_CHUNK_MS = 5 * 60 * 1000;

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];

export interface DecodeFileSegmentOptions {
  segmentMs?: number;
  overlapMs?: number;
  signal?: AbortSignal;
  /** Called once after decode with total duration (ms). */
  onDecoded?: (info: { durationMs: number; estimatedSegments: number }) => void;
  onDecodeProgress?: (info: { phase: 'chunk'; chunkIndex: number; chunkCount: number }) => void;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Upload cancelled', 'AbortError');
  }
}

function isMp3File(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.includes('mpeg') || file.type.includes('mp3') || name.endsWith('.mp3');
}

/** Read duration via a temporary audio element (cheap; no full decode). */
export function probeAudioFileDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      audio.load();
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0;
      cleanup();
      if (durationMs > 0) resolve(durationMs);
      else reject(new Error('Could not read audio length from this file.'));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('Could not read this audio file.'));
    };
    audio.src = url;
  });
}

function skipId3(data: Uint8Array): number {
  if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const size =
      ((data[6] & 0x7f) << 21) |
      ((data[7] & 0x7f) << 14) |
      ((data[8] & 0x7f) << 7) |
      (data[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

function mp3FrameSize(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) return 0;
  const b1 = data[offset + 1];
  if (data[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;

  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (version !== 3 || layer !== 1) return 0;

  const b2 = data[offset + 2];
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 1;
  const bitrate = MPEG1_L3_BITRATES[bitrateIdx] * 1000;
  const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIdx];
  if (!bitrate || !sampleRate) return 0;

  return Math.floor((144 * bitrate) / sampleRate) + padding;
}

function mp3FrameDurationMs(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) return 0;
  const b1 = data[offset + 1];
  if (data[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return 0;
  const version = (b1 >> 3) & 3;
  if (version !== 3) return 0;
  const b2 = data[offset + 2];
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIdx];
  if (!sampleRate) return 0;
  return (1152 / sampleRate) * 1000;
}

/** Split a large MP3 file into decodable byte ranges at frame boundaries. */
function splitMp3IntoDecodeChunks(arrayBuffer: ArrayBuffer, targetChunkMs: number): Uint8Array[] {
  const data = new Uint8Array(arrayBuffer);
  let pos = skipId3(data);
  const chunks: Uint8Array[] = [];
  let chunkStart = pos;
  let chunkDurationMs = 0;

  while (pos < data.length) {
    if (data[pos] !== 0xff || (data[pos + 1] & 0xe0) !== 0xe0) {
      pos += 1;
      continue;
    }
    const frameSize = mp3FrameSize(data, pos);
    if (frameSize <= 0) {
      pos += 1;
      continue;
    }
    const frameMs = mp3FrameDurationMs(data, pos);
    pos += frameSize;
    chunkDurationMs += frameMs;

    if (chunkDurationMs >= targetChunkMs && pos < data.length) {
      chunks.push(data.slice(chunkStart, pos));
      chunkStart = pos;
      chunkDurationMs = 0;
    }
  }

  if (chunkStart < data.length) {
    chunks.push(data.slice(chunkStart));
  }

  return chunks.length > 0 ? chunks : [data];
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

async function resampleTo16kMonoPcm(buffer: AudioBuffer): Promise<Int16Array> {
  const mono = mixToMono(buffer);
  const targetFrames = Math.max(1, Math.ceil(mono.duration * SAMPLE_RATE_TARGET));
  const offline = new OfflineAudioContext(1, targetFrames, SAMPLE_RATE_TARGET);
  const source = offline.createBufferSource();
  source.buffer = mono;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return floatTo16BitPcm(rendered.getChannelData(0));
}

async function decodeArrayBufferTo16kPcm(arrayBuffer: ArrayBuffer): Promise<Int16Array> {
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    if (decoded.length === 0 || decoded.duration <= 0) {
      throw new Error('This audio file appears empty.');
    }
    return resampleTo16kMonoPcm(decoded);
  } finally {
    try {
      await audioContext.close();
    } catch {
      /* ignore */
    }
  }
}

function emitPcmSegments(
  pcmAll: Int16Array,
  onSegment: SegmentCallback,
  options: { segmentMs: number; overlapMs: number; signal?: AbortSignal },
  startSegmentIndex: number,
): { segmentCount: number; durationMs: number } {
  const { segmentMs, overlapMs, signal } = options;
  const samplesPerSegment = Math.max(1, Math.round((segmentMs / 1000) * SAMPLE_RATE_TARGET));
  const samplesPerOverlap = Math.max(0, Math.round((overlapMs / 1000) * SAMPLE_RATE_TARGET));
  const stepSamples = Math.max(1, samplesPerSegment - samplesPerOverlap);
  const minFinalSamples = Math.max(1, Math.round((MIN_FINAL_SEGMENT_MS / 1000) * SAMPLE_RATE_TARGET));

  let segmentIndex = startSegmentIndex;
  let offset = 0;

  while (offset < pcmAll.length) {
    throwIfAborted(signal);
    const remaining = pcmAll.length - offset;
    const isLast = offset + samplesPerSegment >= pcmAll.length;
    const take = isLast ? remaining : samplesPerSegment;

    if (isLast && take < minFinalSamples && segmentIndex > startSegmentIndex) {
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

  const durationMs = Math.round((pcmAll.length / SAMPLE_RATE_TARGET) * 1000);
  return { segmentCount: segmentIndex, durationMs };
}

async function decodeMp3InChunks(
  arrayBuffer: ArrayBuffer,
  durationMs: number,
  onSegment: SegmentCallback,
  options: DecodeFileSegmentOptions,
): Promise<{ durationMs: number; segmentCount: number }> {
  const segmentMs = options.segmentMs ?? SEGMENT_MS;
  const overlapMs = options.overlapMs ?? SEGMENT_OVERLAP_MS;
  const mp3Chunks = splitMp3IntoDecodeChunks(arrayBuffer, MP3_DECODE_CHUNK_MS);
  const stepMs = Math.max(1, segmentMs - overlapMs);
  const estimatedSegments = Math.max(1, Math.ceil(Math.max(0, durationMs - overlapMs) / stepMs));
  options.onDecoded?.({ durationMs, estimatedSegments });

  let segmentIndex = 0;
  for (let i = 0; i < mp3Chunks.length; i++) {
    throwIfAborted(options.signal);
    options.onDecodeProgress?.({ phase: 'chunk', chunkIndex: i + 1, chunkCount: mp3Chunks.length });
    const pcm = await decodeArrayBufferTo16kPcm(
      mp3Chunks[i].buffer.slice(
        mp3Chunks[i].byteOffset,
        mp3Chunks[i].byteOffset + mp3Chunks[i].byteLength,
      ) as ArrayBuffer,
    );
    const result = emitPcmSegments(
      pcm,
      onSegment,
      { segmentMs, overlapMs, signal: options.signal },
      segmentIndex,
    );
    segmentIndex = result.segmentCount;
  }

  if (segmentIndex === 0) {
    throw new Error('Recording is too short to process (need at least a few seconds of audio).');
  }

  return { durationMs, segmentCount: segmentIndex };
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

  let durationMs = 0;
  try {
    durationMs = await probeAudioFileDuration(file);
  } catch {
    /* fall through — duration is optional for small files */
  }
  throwIfAborted(signal);

  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new Error('Could not read this file. Try MP3, WAV, M4A, or WebM.');
  }
  throwIfAborted(signal);

  if (isMp3File(file) && file.size >= CHUNKED_MP3_BYTES) {
    if (durationMs <= 0) {
      durationMs = Math.round((file.size / (128000 / 8)) * 1000);
    }
    return decodeMp3InChunks(arrayBuffer, durationMs, onSegment, options);
  }

  let pcmAll: Int16Array;
  try {
    pcmAll = await decodeArrayBufferTo16kPcm(arrayBuffer);
  } catch {
    if (isMp3File(file)) {
      if (durationMs <= 0) {
        durationMs = Math.round((file.size / (128000 / 8)) * 1000);
      }
      return decodeMp3InChunks(arrayBuffer, durationMs, onSegment, options);
    }
    throw new Error(
      'Could not decode this file in the browser. Try MP3, WAV, M4A, or WebM. Very long recordings may need to be split into two parts.',
    );
  }
  throwIfAborted(signal);

  const decodedDurationMs = Math.round((pcmAll.length / SAMPLE_RATE_TARGET) * 1000);
  durationMs = durationMs > 0 ? durationMs : decodedDurationMs;
  const stepMs = Math.max(1, segmentMs - overlapMs);
  const estimatedSegments = Math.max(1, Math.ceil(Math.max(0, durationMs - overlapMs) / stepMs));
  options.onDecoded?.({ durationMs, estimatedSegments });

  const result = emitPcmSegments(
    pcmAll,
    onSegment,
    { segmentMs, overlapMs, signal },
    0,
  );

  if (result.segmentCount === 0) {
    throw new Error('Recording is too short to process (need at least a few seconds of audio).');
  }

  return { durationMs, segmentCount: result.segmentCount };
}
