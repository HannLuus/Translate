import type { SttResult } from './sttTypes.ts';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

function pcmToWav(pcm16: Uint8Array, sampleRate = 16000): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  v.setUint32(0, 0x52494646, false);
  v.setUint32(4, 36 + dataSize, true);
  v.setUint32(8, 0x57415645, false);
  v.setUint32(12, 0x666d7420, false);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  v.setUint32(36, 0x64617461, false);
  v.setUint32(40, dataSize, true);
  new Uint8Array(buf).set(pcm16, 44);
  return new Uint8Array(buf);
}

/**
 * English batch STT via Groq Whisper — same batch provider WhisperWarp uses on the VPS.
 * Requires GROQ_API_KEY in Edge Function secrets.
 */
export async function transcribeEnglishGroq(audioBytes: Uint8Array): Promise<SttResult> {
  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey?.trim()) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const model = Deno.env.get('GROQ_MODEL') ?? 'whisper-large-v3';
  const prompt = Deno.env.get('GROQ_EN_PROMPT') ?? undefined;
  const wav = pcmToWav(audioBytes);

  const form = new FormData();
  form.append('model', model);
  form.append('language', 'en');
  form.append('response_format', 'json');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  if (prompt?.trim()) form.append('prompt', prompt.trim());

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq STT error ${res.status}: ${err}`);
  }

  const data = await res.json() as { text?: string };
  const transcript = (data.text ?? '').trim();

  return {
    transcript,
    confidence: transcript ? 0.9 : 0,
    alternatives: transcript ? [{ transcript, confidence: 0.9 }] : [],
    model: 'groq_whisper',
  };
}
