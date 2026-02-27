import { GoogleGenerativeAI, type GenerationConfig } from 'npm:@google/generative-ai@^0.24.1';

const GENERATION_CONFIG: GenerationConfig = {
  temperature: 0.1,
  topP: 0.95,
  candidateCount: 1,
};

// Minimum 0.5 s of 16kHz 16-bit mono PCM before sending to Gemini
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

// ---------------------------------------------------------------------------
// System instructions
// ---------------------------------------------------------------------------

const AUDIO_INTERPRET_SYSTEM =
  'You are an experienced Burmese-English conference interpreter working in a live meeting or official briefing. ' +
  'Your job is NOT word-for-word translation. Your job is to LISTEN, grasp the concept and intent of what is being said, ' +
  'and then convey that idea clearly in natural English so the listener fully understands what is happening.\n\n' +
  'How a professional interpreter works:\n' +
  '1. Listen to what the speaker is saying and understand the IDEA behind the words.\n' +
  '2. Convey that idea in clear, natural English — rephrase freely if it makes the meaning clearer.\n' +
  '3. The listener must be able to follow the conversation without needing to ask "what does that mean?"\n\n' +
  'Rules:\n' +
  '- Convey the CONCEPT and INTENT, not a word-for-word rendering. Natural rephrasing is encouraged.\n' +
  '- NEVER invent content: only convey ideas that come from what was actually said in the audio.\n' +
  '- NEVER flip the meaning: if the speaker says NOT to do something, the interpretation must also say NOT to. Never turn a prohibition into a permission.\n' +
  '- NEVER add expected cultural conclusions (e.g. do NOT say "wear a mask" or "stay at home" if the speaker did not say those things).\n' +
  '- Preserve key specifics: named items (foods, medicines, places, people), numbers, and list structure must come through.\n' +
  '- If you cannot confidently identify a specific word, write your best phonetic guess in brackets (e.g. [ngayoke]) rather than dropping it.\n' +
  '- The speaker is always the one giving information TO the listener — they are never asking the listener to speak.\n' +
  '- Output ONLY raw JSON — no markdown, no code fences, no extra text:\n' +
  '  {"burmese":"<burmese transcript>","english":"<interpreted meaning in natural English>"}';

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

  const textPart = 'Listen to this Burmese audio clip. Interpret the meaning into clear, natural English as a conference interpreter would — conveying the concept and intent. NEVER add outside information, and NEVER hallucinate content based on previous context. DO NOT assume the topic is about Health, COVID-19, or any specific Government Official (like U Zaw Min Tun) or Ministry unless you hear those exact words clearly and distinctly. If you are even 1% unsure of a word, use a phonetic transliteration in brackets [like this] instead of guessing a common name.';
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
