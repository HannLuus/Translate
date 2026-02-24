import { GoogleGenerativeAI, type GenerationConfig } from 'npm:@google/generative-ai@^0.24.1';

const GENERATION_CONFIG: GenerationConfig = {
  temperature: 0.2,
  topP: 0.95,
  candidateCount: 1,
};

// Minimum 0.5 s of 16kHz 16-bit mono PCM before sending to Gemini
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

// ---------------------------------------------------------------------------
// System instructions
// ---------------------------------------------------------------------------

const AUDIO_INTERPRET_SYSTEM =
  'You are a professional Burmese-English live interpreter. ' +
  'You will receive a short audio clip of Burmese speech, typically from a public announcement, safety briefing, meeting, or official address. ' +
  'Transcribe it accurately and translate it to natural English.\n\n' +
  'Rules:\n' +
  '- Accuracy of meaning is your absolute top priority. Translate what was SAID — nothing more, nothing less.\n' +
  '- NEVER add content that was not spoken. This means: no logical conclusions, no expected advice, no culturally anticipated responses. A concrete example of what is FORBIDDEN: if the speech is about COVID-19 and the speaker did NOT say "wear a mask" or "stay at home", those words must NOT appear in the translation — even if they seem like an obvious or expected conclusion.\n' +
  '- NEVER substitute what you think the speaker should have said. Even if the content seems surprising or unconventional (e.g. recommending a specific food as medicine), translate it exactly and faithfully.\n' +
  '- Always identify and preserve the grammatical subject of each sentence. Never replace a specific noun (food, plant, medicine, object, person, place) with "it", "the thing", or a vague description of its properties. If the speaker names a specific food or plant, that name must appear in the translation.\n' +
  '- If you cannot confidently identify a specific word — especially a food, plant, medicine, or proper noun — write your best phonetic transliteration in brackets (e.g. [ngayoke]) rather than silently omitting or vaguely describing it.\n' +
  '- Negations are critical — if the source says NOT to do something, the translation MUST also say NOT to. Never flip a prohibition.\n' +
  '- Preserve all numbers, counts, and lists exactly (e.g. if the speaker says "2 precautions" or "point number one", keep those specifics).\n' +
  '- Preserve tone exactly: formal stays formal, casual stays casual, questions stay questions.\n' +
  '- Translate to complete, natural English sentences — never fragments or word lists.\n' +
  '- If the clip is a sentence fragment, use the recent context to complete the meaning.\n' +
  '- Speaker role: the person being recorded is always giving information, instructions, or warnings TO the listener. When the Burmese subject is omitted, default to the speaker as the one delivering information (e.g. "I will tell you..." not "Please tell me...").\n' +
  '- Output ONLY raw JSON — no markdown, no code fences, no extra text:\n' +
  '  {"burmese":"<burmese transcript>","english":"<english translation>"}';

const ENGLISH_TO_BURMESE_SYSTEM =
  'You are a professional live interpreter for English-to-Burmese. ' +
  'Accuracy of meaning is your top priority — produce the most faithful Burmese translation of the English speech.\n\n' +
  'Rules:\n' +
  '- Output ONLY the Burmese translation in Burmese script. No romanization, no explanations, no brackets.\n' +
  '- Use natural spoken Burmese — not a word-for-word literal translation.\n' +
  '- Match the register of the source: polite English should use appropriate Burmese honorifics.\n' +
  '- Do not add or omit any meaning from the source.';

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

let _ai: GoogleGenerativeAI | null = null;
function getAI(): GoogleGenerativeAI {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  if (!_ai) _ai = new GoogleGenerativeAI(apiKey);
  return _ai;
}

/** Delays for retry backoff (rate limits in long meetings). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if the error is a Gemini rate limit or quota error — safe to retry. */
function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|quota|Quota exceeded|resource_exhausted|rate limit|RESOURCE_EXHAUSTED|too many requests/i.test(msg);
}

const RETRY_DELAYS_MS = [2000, 4000, 8000]; // 3 retries after initial attempt (4 attempts total)

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Single-step Burmese audio → English translation via Gemini multimodal.
 * Replaces the two-step Google STT + Gemini translation pipeline so that
 * Gemini resolves ambiguous Burmese words (e.g. လေ = wind vs airplane)
 * using full audio context rather than relying on an error-prone transcript.
 */
export async function transcribeAndTranslateAudio(
  audioBytes: Uint8Array,
  recentContext?: string | null,
): Promise<{ burmeseText: string; englishText: string }> {
  if (audioBytes.length < MIN_AUDIO_BYTES) return { burmeseText: '', englishText: '' };

  const wavBytes = pcmToWav(audioBytes);
  const audioBase64 = bytesToBase64(wavBytes);

  const model = getAI().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: AUDIO_INTERPRET_SYSTEM,
    generationConfig: GENERATION_CONFIG,
  });

  const textPart = 'Transcribe and translate the Burmese audio clip.';
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        console.warn(`[gemini] Retry ${attempt}/${maxAttempts - 1} after rate limit`);
      }

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: audioBase64 } },
            { text: textPart },
          ],
        }],
      });

      const resp = result.response;
      if (!resp?.candidates?.length) {
        const blockReason = (resp as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
        throw new Error(blockReason ? `Gemini blocked: ${blockReason}` : 'Gemini returned no candidates');
      }

      const candidate = resp.candidates[0];
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini stopped with reason: ${candidate.finishReason}`);
      }

      const raw = (candidate.content?.parts?.[0]?.text ?? '').trim();
      if (!raw) return { burmeseText: '', englishText: '' };

      try {
        const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
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

/** English → Burmese text translation (used by response / response-audio functions). */
export async function translateWithGemini(
  text: string,
  toEnglish: boolean,
  recentContext?: string | null,
): Promise<string> {
  if (!text?.trim()) return '';

  const model = getAI().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: ENGLISH_TO_BURMESE_SYSTEM,
    generationConfig: GENERATION_CONFIG,
  });

  const userMessage = buildUserMessage(text, toEnglish ? recentContext : null);
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(RETRY_DELAYS_MS[attempt - 1]);
        console.warn(`[gemini] Retry ${attempt}/${maxAttempts - 1} after rate limit`);
      }

      const result = await model.generateContent(userMessage);
      const resp = result.response;

      if (!resp?.candidates?.length) {
        const blockReason = (resp as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
        throw new Error(blockReason ? `Gemini blocked: ${blockReason}` : 'Gemini returned no candidates');
      }

      const candidate = resp.candidates[0];
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini stopped with reason: ${candidate.finishReason}`);
      }

      const part = candidate.content?.parts?.[0];
      return (part?.text ?? '').trim();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts - 1 || !isRetryableError(e)) throw e;
    }
  }

  throw lastError;
}
