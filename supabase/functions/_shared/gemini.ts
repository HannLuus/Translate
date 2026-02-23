import { GoogleGenerativeAI } from 'npm:@google/generative-ai@^0.24.1';

const BURMESE_TO_ENGLISH_PROMPT =
  'Translate this Burmese dialogue to natural English for an earbud feed. Output only the translation, no explanations.';
const ENGLISH_TO_BURMESE_PROMPT =
  'Translate this English dialogue to natural Burmese for a local speaker to hear. Output only the translation, no explanations.';

function buildTranslationPrompt(
  promptBase: string,
  currentText: string,
  previousSentence?: string | null,
): string {
  if (!previousSentence?.trim()) return `${promptBase}\n\n${currentText.trim()}`;
  return `${promptBase}\n\nPrevious sentence (for context): ${previousSentence.trim()}\n\nCurrent to translate: ${currentText.trim()}`;
}

export async function translateWithGemini(
  text: string,
  toEnglish: boolean,
  previousSentence?: string | null,
): Promise<string> {
  if (!text?.trim()) return '';

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const promptBase = toEnglish ? BURMESE_TO_ENGLISH_PROMPT : ENGLISH_TO_BURMESE_PROMPT;
  const prompt = buildTranslationPrompt(promptBase, text, previousSentence);

  const result = await model.generateContent(prompt);
  const resp = result.response;

  if (!resp?.candidates?.[0]) {
    const blockReason =
      resp?.candidates?.[0]?.finishReason ?? (resp as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini blocked: ${blockReason}` : 'Gemini returned no text');
  }

  const part = resp.candidates[0].content?.parts?.[0];
  return (part?.text ?? '').trim();
}
