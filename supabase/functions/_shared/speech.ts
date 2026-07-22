import { getAccessToken, getProjectId } from './googleAuth.ts';
import { transcribeBurmeseElevenLabs } from './elevenlabsStt.ts';
import { transcribeEnglishGroq } from './groqStt.ts';
import { buildPhraseHints, parseGlossaryHints, type GlossaryHint } from './terminology.ts';
import type { SttAlternative, SttResult } from './sttTypes.ts';

export type { SttAlternative, SttResult } from './sttTypes.ts';

const SPEECH_REGION = 'asia-southeast1';
const SAMPLE_RATE_HZ = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE_HZ * BYTES_PER_SAMPLE;
const MIN_AUDIO_BYTES = SAMPLE_RATE_HZ * 0.5 * BYTES_PER_SAMPLE;

/**
 * Google Speech-to-Text v2 synchronous `:recognize` rejects audio longer than 60s
 * ("Audio can be of a maximum of 60 seconds."). Meeting segments are ~180s, so we
 * chunk before calling Google. Stay under the hard cap with a small overlap.
 */
const GOOGLE_RECOGNIZE_MAX_SECONDS = 55;
const GOOGLE_CHUNK_OVERLAP_SECONDS = 1.5;
const GOOGLE_MAX_CHUNK_BYTES = GOOGLE_RECOGNIZE_MAX_SECONDS * BYTES_PER_SECOND;
const GOOGLE_OVERLAP_BYTES = Math.floor(GOOGLE_CHUNK_OVERLAP_SECONDS * BYTES_PER_SECOND);

/** Minimum confidence to skip second-pass STT refinement. */
export const STT_CONFIDENCE_THRESHOLD = 0.72;

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function meanConfidence(alternatives: SttAlternative[]): number {
  if (alternatives.length === 0) return 0;
  const sum = alternatives.reduce((n, a) => n + (a.confidence || 0), 0);
  return sum / alternatives.length;
}

async function recognizeAudioDetailed(
  audioBase64: string,
  languageCodes: string[],
  phraseHints?: GlossaryHint[],
  preferredModel?: string,
): Promise<SttResult> {
  const token = await getAccessToken();
  const projectId = getProjectId();
  const recognizer = `projects/${projectId}/locations/${SPEECH_REGION}/recognizers/_`;
  const url = `https://${SPEECH_REGION}-speech.googleapis.com/v2/${recognizer}:recognize`;

  const models = preferredModel ? [preferredModel, 'chirp_3', 'chirp_2'] : ['chirp_3', 'chirp_2'];
  const uniqueModels = [...new Set(models)];

  const inlinePhrases = buildPhraseHints(phraseHints ?? []);

  for (const model of uniqueModels) {
    const config: Record<string, unknown> = {
      model,
      languageCodes,
      explicitDecodingConfig: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        audioChannelCount: 1,
      },
    };

    if (inlinePhrases.length > 0) {
      config.adaptation = {
        phraseSets: [{
          inlinePhraseSet: {
            phrases: inlinePhrases,
          },
        }],
      };
    }

    const configMaskParts = ['model', 'languageCodes', 'explicitDecodingConfig'];
    if (inlinePhrases.length > 0) configMaskParts.push('adaptation');

    const body = {
      config,
      configMask: configMaskParts.join(','),
      content: audioBase64,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      const isUnsupported =
        err.includes('not found') ||
        err.includes('not exist') ||
        err.includes('not supported') ||
        err.includes('unsupported') ||
        err.includes('invalid') ||
        err.includes('INVALID_ARGUMENT');

      if (uniqueModels.indexOf(model) < uniqueModels.length - 1 && isUnsupported) {
        console.warn(`[STT] ${model} rejected, trying next model: ${err}`);
        continue;
      }
      throw new Error(`Speech API error: ${err}`);
    }

    const data = await res.json() as {
      results?: {
        alternatives?: { transcript?: string; confidence?: number }[];
      }[];
    };

    const alternatives: SttAlternative[] = [];
    for (const result of data.results ?? []) {
      for (const alt of result.alternatives ?? []) {
        const transcript = (alt.transcript ?? '').trim();
        if (!transcript) continue;
        alternatives.push({
          transcript,
          confidence: typeof alt.confidence === 'number' ? alt.confidence : 0.75,
        });
      }
    }

    const transcript = alternatives.map((a) => a.transcript).join(' ').trim();
    const confidence = alternatives.length > 0
      ? Math.max(...alternatives.map((a) => a.confidence))
      : meanConfidence(alternatives);

    return { transcript, confidence, alternatives, model };
  }

  return { transcript: '', confidence: 0, alternatives: [], model: 'none' };
}

/** Split long PCM and call sync Google recognize per chunk (≤60s API limit). */
async function recognizePcmDetailed(
  audioBytes: Uint8Array,
  languageCodes: string[],
  phraseHints?: GlossaryHint[],
  preferredModel?: string,
): Promise<SttResult> {
  if (audioBytes.length <= GOOGLE_MAX_CHUNK_BYTES) {
    return recognizeAudioDetailed(
      bytesToBase64(audioBytes),
      languageCodes,
      phraseHints,
      preferredModel,
    );
  }

  const step = Math.max(GOOGLE_MAX_CHUNK_BYTES - GOOGLE_OVERLAP_BYTES, MIN_AUDIO_BYTES);
  const transcripts: string[] = [];
  const confidences: number[] = [];
  const alternatives: SttAlternative[] = [];
  let model = 'none';

  for (let start = 0; start < audioBytes.length; start += step) {
    const end = Math.min(start + GOOGLE_MAX_CHUNK_BYTES, audioBytes.length);
    const chunk = audioBytes.subarray(start, end);
    if (chunk.length < MIN_AUDIO_BYTES) break;

    const part = await recognizeAudioDetailed(
      bytesToBase64(chunk),
      languageCodes,
      phraseHints,
      preferredModel,
    );
    if (part.transcript) {
      transcripts.push(part.transcript);
      confidences.push(part.confidence);
      alternatives.push(...part.alternatives);
      model = part.model;
    }
    if (end >= audioBytes.length) break;
  }

  if (transcripts.length === 0) {
    return { transcript: '', confidence: 0, alternatives: [], model };
  }

  return {
    transcript: transcripts.join(' ').replace(/\s+/g, ' ').trim(),
    confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    alternatives: alternatives.slice(0, 8),
    model,
  };
}

export async function transcribeBurmeseDetailed(
  audioBytes: Uint8Array,
  meetingContext?: string | null,
  options?: { preferredModel?: string; forceGoogle?: boolean },
): Promise<SttResult> {
  if (audioBytes.length < MIN_AUDIO_BYTES) {
    return { transcript: '', confidence: 0, alternatives: [], model: 'none' };
  }

  const hints = parseGlossaryHints(meetingContext);

  // Primary path (WhisperWarp-proven): ElevenLabs Scribe for Myanmar Unicode Burmese.
  if (!options?.forceGoogle && Deno.env.get('ELEVENLABS_API_KEY')) {
    try {
      const scribe = await transcribeBurmeseElevenLabs(audioBytes, meetingContext);
      if (scribe.transcript) return scribe;
    } catch (err) {
      console.warn('[STT] ElevenLabs Scribe failed, falling back to Google Chirp:', err);
    }
  }

  return recognizePcmDetailed(audioBytes, ['my-MM'], hints, options?.preferredModel);
}

/** Second-pass refinement: alternate provider/model for low-confidence segments. */
export async function refineBurmeseTranscription(
  audioBytes: Uint8Array,
  primary: SttResult,
  meetingContext?: string | null,
): Promise<SttResult> {
  const usedElevenLabs = primary.model === 'elevenlabs_scribe';

  if (usedElevenLabs) {
    try {
      const hints = parseGlossaryHints(meetingContext);
      const refined = await recognizePcmDetailed(audioBytes, ['my-MM'], hints, 'chirp_3');
      if (refined.transcript && refined.confidence >= primary.confidence) return refined;
    } catch (err) {
      console.warn('[STT] Google refine after ElevenLabs failed; keeping primary:', err);
    }
    return primary;
  }

  if (Deno.env.get('ELEVENLABS_API_KEY')) {
    try {
      const refined = await transcribeBurmeseElevenLabs(audioBytes, meetingContext);
      if (refined.transcript && refined.confidence >= primary.confidence) return refined;
    } catch {
      // keep primary
    }
  }

  try {
    const alternateModel = primary.model === 'chirp_3' ? 'chirp_2' : 'chirp_3';
    const refined = await transcribeBurmeseDetailed(audioBytes, meetingContext, {
      preferredModel: alternateModel,
      forceGoogle: true,
    });

    if (!refined.transcript) return primary;
    if (refined.confidence >= primary.confidence) return refined;

    if (refined.alternatives.length > 0 && primary.confidence < STT_CONFIDENCE_THRESHOLD) {
      return {
        ...primary,
        confidence: Math.max(primary.confidence, refined.confidence * 0.95),
        alternatives: [...primary.alternatives, ...refined.alternatives].slice(0, 5),
      };
    }
  } catch (err) {
    console.warn('[STT] Google alternate-model refine failed; keeping primary:', err);
  }

  return primary;
}

export async function transcribeBurmese(
  audioBytes: Uint8Array,
  meetingContext?: string | null,
): Promise<string> {
  const result = await transcribeBurmeseDetailed(audioBytes, meetingContext);
  return result.transcript;
}

export async function transcribeEnglish(audioBytes: Uint8Array): Promise<string> {
  if (audioBytes.length < MIN_AUDIO_BYTES) return '';

  if (Deno.env.get('GROQ_API_KEY')) {
    try {
      const groq = await transcribeEnglishGroq(audioBytes);
      if (groq.transcript) return groq.transcript;
    } catch (err) {
      console.warn('[STT] Groq English failed, falling back to Google Chirp:', err);
    }
  }

  const result = await recognizePcmDetailed(audioBytes, ['en-US']);
  return result.transcript;
}
