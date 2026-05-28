import { parseGlossaryHints } from './terminology.ts';
import type { SttResult } from './sttTypes.ts';

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

/** Myanmar Unicode blocks — WhisperWarp rejects transcripts outside this script. */
const MYANMAR_UNICODE_RE = /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/;

export function isMyanmarUnicode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return MYANMAR_UNICODE_RE.test(trimmed);
}

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

function buildKeyterms(meetingContext?: string | null): string[] {
  const fromGlossary = parseGlossaryHints(meetingContext).map((h) => h.term.trim()).filter(Boolean);
  const envTerms = (Deno.env.get('ELEVENLABS_MYANMAR_KEYTERMS') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set([...fromGlossary, ...envTerms])].slice(0, 100);
}

/**
 * Burmese batch STT via ElevenLabs Scribe — same provider WhisperWarp uses on the VPS.
 * Requires ELEVENLABS_API_KEY in Edge Function secrets.
 */
export async function transcribeBurmeseElevenLabs(
  audioBytes: Uint8Array,
  meetingContext?: string | null,
): Promise<SttResult> {
  const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
  if (!apiKey?.trim()) {
    throw new Error('ELEVENLABS_API_KEY not configured');
  }

  const model = Deno.env.get('ELEVENLABS_STT_MODEL') ?? 'scribe_v2';
  const wav = pcmToWav(audioBytes);
  const form = new FormData();
  form.append('model_id', model);
  form.append('language_code', 'my');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');

  for (const term of buildKeyterms(meetingContext)) {
    form.append('keyterms', term);
  }

  const res = await fetch(ELEVENLABS_STT_URL, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs STT error ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    text?: string;
    language_probability?: number;
  };

  const transcript = (data.text ?? '').trim();
  if (!transcript) {
    return { transcript: '', confidence: 0, alternatives: [], model: 'elevenlabs_scribe' };
  }

  if (!isMyanmarUnicode(transcript)) {
    throw new Error('ElevenLabs returned non-Myanmar Unicode text');
  }

  const confidence = typeof data.language_probability === 'number'
    ? data.language_probability
    : 0.88;

  return {
    transcript,
    confidence,
    alternatives: [{ transcript, confidence }],
    model: 'elevenlabs_scribe',
  };
}
