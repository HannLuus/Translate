import { getAccessToken, getProjectId } from './googleAuth.ts';
import { transcribeBurmeseElevenLabs } from './elevenlabsStt.ts';
import { transcribeEnglishGroq } from './groqStt.ts';
import { buildPhraseHints, parseGlossaryHints, type GlossaryHint } from './terminology.ts';
import type { SttAlternative, SttResult } from './sttTypes.ts';

export type { SttAlternative, SttResult } from './sttTypes.ts';

const SPEECH_REGION = 'asia-southeast1';
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

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

  const audioBase64 = bytesToBase64(audioBytes);
  return recognizeAudioDetailed(audioBase64, ['my-MM'], hints, options?.preferredModel);
}

/** Second-pass refinement: alternate provider/model for low-confidence segments. */
export async function refineBurmeseTranscription(
  audioBytes: Uint8Array,
  primary: SttResult,
  meetingContext?: string | null,
): Promise<SttResult> {
  const usedElevenLabs = primary.model === 'elevenlabs_scribe';

  if (usedElevenLabs) {
    const audioBase64 = bytesToBase64(audioBytes);
    const hints = parseGlossaryHints(meetingContext);
    const refined = await recognizeAudioDetailed(audioBase64, ['my-MM'], hints, 'chirp_3');
    if (refined.transcript && refined.confidence >= primary.confidence) return refined;
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

  const audioBase64 = bytesToBase64(audioBytes);
  const result = await recognizeAudioDetailed(audioBase64, ['en-US']);
  return result.transcript;
}
