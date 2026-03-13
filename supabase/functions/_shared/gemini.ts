import { getAccessToken, getProjectId } from './googleAuth.ts';

const VERTEX_MODEL = 'gemini-2.0-flash';

const GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.95,
  candidateCount: 1,
  /** Max allowed by Vertex for gemini-2.0-flash is 8192. Use it for long clean-and-summarize outputs. */
  maxOutputTokens: 8192,
};

// Minimum 0.5 s of 16kHz 16-bit mono PCM before sending to Gemini
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

// ---------------------------------------------------------------------------
// System instructions
// ---------------------------------------------------------------------------

const AUDIO_INTERPRET_SYSTEM =
  'You are a clinical Burmese-to-English audio interpreter. Your ONLY goal is to convey the sounds heard in the audio into English meaning. ' +
  'You have NO outside knowledge of Burmese news, politics, or health departments.\n\n' +
  'STRICT RULES:\n' +
  '1. Listen ONLY to the sound waves. DO NOT autocomplete or guess based on common phrases.\n' +
  '2. NEVER mention: "Ministry of Health", "COVID-19", "U Zaw Min Tun", or any specific Government Official or Ministry UNLESS those exact specific nouns are spoken with 100% clarity.\n' +
  '3. If the audio is about a storm, stay ONLY on the topic of the storm. If you hear an ambiguous word, DO NOT map it to a health or political term. Map it to the most simple, everyday meaning.\n' +
  '4. Ignore stammers, background noise, or garbled sounds. DO NOT output phonetic babble (like [na] [la] [ta] [ba]). ONLY use phonetic brackets for clear, deliberate proper nouns (like places or names) that you cannot translate.\n' +
  '5. The speaker is giving information TO the listener. Convey the CONCEPT and INTENT, but stay strictly grounded in the audio provided.\n' +
  '6. Output ONLY raw JSON:\n' +
  '  {"burmese":"<literal transcript>","english":"<interpreted meaning>"}';

const BURMESE_TO_ENGLISH_SYSTEM =
  'You are a live interpreter. Translate the Burmese to natural, fluent English.\n\n' +
  'Rules: Use complete, well-formed sentences. Preserve tone and connotation (formal, casual, question, etc.). ' +
  'If the current Burmese is a fragment or mid-sentence, combine it with the recent context to produce one coherent English sentence where possible. ' +
  'Output only the translation, no explanations or brackets.';

const ENGLISH_TO_BURMESE_SYSTEM =
  'You are an experienced English-to-Burmese conference interpreter working in a live meeting. ' +
  'Your job is to convey the concept and intent of what was said in natural, clear Burmese — not word-for-word translation.\n\n' +
  'Rules:\n' +
  '- Output ONLY the Burmese interpretation in Burmese script. No romanization, no explanations, no brackets.\n' +
  '- Use natural spoken Burmese that a local listener will understand immediately.\n' +
  '- Match the register: formal English gets formal Burmese with appropriate honorifics.\n' +
  '- Convey the full idea — rephrase freely, but never add content that was not said and never invert the meaning.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap raw 16-bit PCM bytes in a WAV container so Gemini can decode them. */
function pcmToWav(pcm16: Uint8Array, sampleRate = 16000): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  v.setUint32(0,  0x52494646, false); // "RIFF"
  v.setUint32(4,  36 + dataSize, true);
  v.setUint32(8,  0x57415645, false); // "WAVE"
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, dataSize, true);
  new Uint8Array(buf).set(pcm16, 44);
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function buildUserMessage(currentText: string, recentContext?: string | null): string {
  const trimmed = currentText.trim();
  if (!recentContext?.trim()) return trimmed;
  return `Recent context (prior English translation): ${recentContext.trim()}\n\nCurrent to translate: ${trimmed}`;
}

function getVertexRegion(): string {
  return Deno.env.get('VERTEX_AI_REGION') ?? 'us-central1';
}


/** Vertex AI generateContent request/response shapes (REST API). */
interface VertexPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface VertexContent {
  role: string;
  parts: VertexPart[];
}

interface VertexGenerateRequest {
  contents: VertexContent[];
  systemInstruction?: { parts: VertexPart[] };
  generationConfig?: Record<string, unknown>;
}

interface VertexGenerateResponse {
  candidates?: Array<{
    content?: { parts?: VertexPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Call Vertex AI generateContent REST API using the service account credentials.
 * GOOGLE_APPLICATION_CREDENTIALS_JSON is required (same credentials used by TTS/STT).
 * The service account must have the "Vertex AI User" role.
 */
async function vertexGenerateContent(
  contents: VertexContent[],
  systemInstruction?: string | null,
): Promise<{ text: string; blockReason?: string; finishReason?: string }> {
  const region = getVertexRegion();
  const projectId = getProjectId();

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${VERTEX_MODEL}:generateContent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${await getAccessToken()}`,
  };

  const body: VertexGenerateRequest = {
    contents,
    generationConfig: GENERATION_CONFIG,
  };
  if (systemInstruction?.trim()) {
    body.systemInstruction = { parts: [{ text: systemInstruction.trim() }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as VertexGenerateResponse;
  const blockReason = data.promptFeedback?.blockReason;
  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const text = candidate?.content?.parts?.[0]?.text ?? '';

  return { text: text.trim(), blockReason, finishReason };
}

/** Delays for retry backoff (rate limits in long meetings). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if the error is a Gemini/Vertex rate limit or quota error — safe to retry. */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|quota|Quota exceeded|resource_exhausted|rate limit|RESOURCE_EXHAUSTED|too many requests/i.test(msg);
}

const RETRY_DELAYS_MS = [2000, 4000, 8000]; // 3 retries after initial attempt (4 attempts total)

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Single-step Burmese audio → English translation via Vertex AI Gemini multimodal.
 * Uses the same service account as Speech-to-Text (GOOGLE_APPLICATION_CREDENTIALS_JSON).
 */
export async function transcribeAndTranslateAudio(
  audioBytes: Uint8Array,
  meetingContext?: string | null,
): Promise<{ burmeseText: string; englishText: string }> {
  if (audioBytes.length < MIN_AUDIO_BYTES) return { burmeseText: '', englishText: '' };

  const wavBytes = pcmToWav(audioBytes);
  const audioBase64 = bytesToBase64(wavBytes);

  let systemPrompt = AUDIO_INTERPRET_SYSTEM;
  if (meetingContext?.trim()) {
    systemPrompt += '\n\nIMPORTANT MEETING CONTEXT & GLOSSARY:\n' +
      'The following information is provided to help you correctly spell and identify names, acronyms, and industry terms that might be spoken in the audio.\n' +
      'RULE: Use this to guide your transcription of difficult words, BUT DO NOT hallucinate these terms if they are not actually spoken.\n' +
      '---\n' +
      meetingContext.trim() +
      '\n---';
  }

  const textPart = 'Listen to this Burmese audio clip. Transcribe what was said, then interpret it. STAY RIGIDLY GROUNDED in the audio. DO NOT hallucinate common phrases or news reports. If a word is unclear, use phonetic brackets [like this]. DO NOT add ANY outside information.';
  const contents: VertexContent[] = [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'audio/wav', data: audioBase64 } },
      { text: textPart },
    ],
  }];

  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        console.warn(`[vertex] Retry ${attempt}/${maxAttempts - 1} after rate limit`);
      }

      const { text: raw, blockReason, finishReason } = await vertexGenerateContent(contents, systemPrompt);

      if (blockReason) {
        throw new Error(`Vertex blocked: ${blockReason}`);
      }
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(`Vertex stopped with reason: ${finishReason}`);
      }
      if (!raw) return { burmeseText: '', englishText: '' };

      try {
        const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
        const parsed = JSON.parse(json) as { burmese?: string; english?: string };
        return {
          burmeseText: (parsed.burmese ?? '').trim(),
          englishText: (parsed.english ?? '').trim(),
        };
      } catch {
        return { burmeseText: '', englishText: raw };
      }
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts - 1 || !isRetryableError(e)) throw e;
    }
  }

  throw lastError;
}

const CLEAN_AND_SUMMARIZE_SYSTEM =
  'You are a meeting transcript editor and summarizer. You receive a raw live-interpretation transcript and optional meeting context (glossary, briefing).\n\n' +
  'TASKS:\n' +
  '1. CLEAN: Correct the transcript using the meeting context. Fix misinterpreted terms (e.g. if the context says the company sells tractors, do not leave in medicine or unrelated terms that were likely misheard). Fix names and acronyms using the glossary. Keep the rest of the content intact; only correct clear errors.\n' +
  '2. SUMMARIZE: Write a short meeting summary (2–4 sentences) and 3–5 key points.\n\n' +
  'OUTPUT: Reply with ONLY valid JSON, no markdown or extra text:\n' +
  '{"cleanedTranscript":"<full cleaned transcript>","summary":"<short summary>","keyPoints":["<point 1>","<point 2>",...]}';

const MAX_TRANSCRIPT_CHARS = 60_000;

/** Clean transcript using meeting context and produce summary + key points (Otter-style). */
export async function cleanTranscriptAndSummarize(
  transcript: string,
  meetingContext?: string | null,
): Promise<{ cleanedTranscript: string; summary: string; keyPoints: string[] }> {
  const trimmed = transcript?.trim() ?? '';
  if (!trimmed) {
    return { cleanedTranscript: '', summary: '', keyPoints: [] };
  }

  const truncated = trimmed.length > MAX_TRANSCRIPT_CHARS;
  const toSend = truncated ? trimmed.slice(-MAX_TRANSCRIPT_CHARS) : trimmed;

  let systemPrompt = CLEAN_AND_SUMMARIZE_SYSTEM;
  if (meetingContext?.trim()) {
    systemPrompt += '\n\nMEETING CONTEXT (use this to correct terms and stay on topic):\n---\n' + meetingContext.trim() + '\n---';
  }
  if (truncated) {
    systemPrompt += '\n\nThe transcript you receive is the final portion of a long meeting; the beginning was omitted due to length. Clean and summarize based on what you receive.';
  }

  const userMessage = `Process this meeting transcript. Clean it using the meeting context, then provide the summary and key points. Output only the JSON object.\n\nTRANSCRIPT:\n\n${toSend}`;
  const contents: VertexContent[] = [{ role: 'user', parts: [{ text: userMessage }] }];

  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        console.warn(`[vertex] Retry ${attempt}/${maxAttempts - 1} after rate limit`);
      }

      const { text: raw, blockReason, finishReason } = await vertexGenerateContent(contents, systemPrompt);

      if (blockReason) {
        throw new Error(`Vertex blocked: ${blockReason}`);
      }
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(`Vertex stopped with reason: ${finishReason}`);
      }
      if (!raw) {
        const fallbackCleaned = truncated ? '[Earlier part omitted due to length.]\n\n' + toSend : trimmed;
        return { cleanedTranscript: fallbackCleaned, summary: 'Summary unavailable.', keyPoints: [] };
      }

      try {
        const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/g, '').trim();
        const parsed = JSON.parse(json) as { cleanedTranscript?: string; summary?: string; keyPoints?: string[] };
        let cleaned = typeof parsed.cleanedTranscript === 'string' ? parsed.cleanedTranscript.trim() : toSend;
        if (truncated) {
          cleaned = '[Earlier part of the meeting was omitted due to length.]\n\n' + cleaned;
        }
        return {
          cleanedTranscript: cleaned,
          summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : 'Summary unavailable.',
          keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.filter((p): p is string => typeof p === 'string').slice(0, 10) : [],
        };
      } catch {
        const fallback = truncated ? '[Earlier part omitted due to length.]\n\n' + toSend : trimmed;
        return { cleanedTranscript: fallback, summary: 'Summary unavailable.', keyPoints: [] };
      }
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts - 1 || !isRetryableError(e)) throw e;
    }
  }

  throw lastError;
}

/** English → Burmese text translation (used by response / response-audio functions). */
export async function translateWithGemini(
  text: string,
  toEnglish: boolean,
  recentContext?: string | null,
): Promise<string> {
  if (!text?.trim()) return '';

  const userMessage = buildUserMessage(text, toEnglish ? recentContext : null);
  const contents: VertexContent[] = [{ role: 'user', parts: [{ text: userMessage }] }];

  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        console.warn(`[vertex] Retry ${attempt}/${maxAttempts - 1} after rate limit`);
      }

      const systemInstruction = toEnglish ? BURMESE_TO_ENGLISH_SYSTEM : ENGLISH_TO_BURMESE_SYSTEM;
      const { text: out, blockReason, finishReason } = await vertexGenerateContent(contents, systemInstruction);

      if (blockReason) {
        throw new Error(`Vertex blocked: ${blockReason}`);
      }
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(`Vertex stopped with reason: ${finishReason}`);
      }

      return out;
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts - 1 || !isRetryableError(e)) throw e;
    }
  }

  throw lastError;
}
