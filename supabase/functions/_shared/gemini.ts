import { GoogleGenerativeAI, type GenerationConfig } from 'npm:@google/generative-ai@^0.24.1';

const GENERATION_CONFIG: GenerationConfig = {
  temperature: 0.4,
  topP: 0.95,
  candidateCount: 1,
};

const BURMESE_TO_ENGLISH_SYSTEM =
  'You are a professional live interpreter for Burmese-English. ' +
  'Accuracy of meaning is your top priority — produce the most faithful English translation of the Burmese speech.\n\n' +
  'Rules:\n' +
  '- Output ONLY the English translation. No explanations, no brackets, no notes.\n' +
  '- Write complete, natural English sentences — never a word list or bare fragment.\n' +
  '- Preserve the tone and intent exactly: formal stays formal, casual stays casual, questions stay questions.\n' +
  '- Negations are critical — if the source says do NOT do something, the translation MUST also say do NOT. Never flip a prohibition into a permission.\n' +
  '- If the input is a fragment or mid-sentence, use the recent context to produce a coherent sentence.\n' +
  '- Do not add or omit any meaning from the source.';

const ENGLISH_TO_BURMESE_SYSTEM =
  'You are a professional live interpreter for English-to-Burmese. ' +
  'Accuracy of meaning is your top priority — produce the most faithful Burmese translation of the English speech.\n\n' +
  'Rules:\n' +
  '- Output ONLY the Burmese translation in Burmese script. No romanization, no explanations, no brackets.\n' +
  '- Use natural spoken Burmese — not a word-for-word literal translation.\n' +
  '- Match the register of the source: polite English should use appropriate Burmese honorifics.\n' +
  '- Do not add or omit any meaning from the source.';

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

export async function translateWithGemini(
  text: string,
  toEnglish: boolean,
  recentContext?: string | null,
): Promise<string> {
  if (!text?.trim()) return '';

  const systemInstruction = toEnglish ? BURMESE_TO_ENGLISH_SYSTEM : ENGLISH_TO_BURMESE_SYSTEM;
  const model = getAI().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction,
    generationConfig: GENERATION_CONFIG,
  });

  const userMessage = buildUserMessage(text, toEnglish ? recentContext : null);
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
}
