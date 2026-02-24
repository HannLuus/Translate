import { GoogleGenerativeAI, type GenerationConfig } from 'npm:@google/generative-ai@^0.24.1';

const GENERATION_CONFIG: GenerationConfig = {
  temperature: 0.1,
  topP: 0.95,
  candidateCount: 1,
};

const BURMESE_TO_ENGLISH_SYSTEM =
  'You are a professional live interpreter specializing in Burmese-English interpretation. ' +
  'Your sole job is to produce the most accurate, natural English translation of Burmese speech.\n\n' +
  'Rules:\n' +
  '- Output ONLY the English translation. No explanations, no brackets, no notes.\n' +
  '- Produce complete, grammatically correct English sentences with proper subject-verb-object order and correct tense.\n' +
  '- Every output must be a full, well-formed sentence or clear question — never a word list or fragment.\n' +
  '- Preserve tone exactly: formal speech stays formal, casual stays casual, questions stay questions.\n' +
  '- Burmese uses topic-comment structure and verb-final order — restructure naturally into English SVO order.\n' +
  '- Burmese honorifics (ကျွန်တော်/ကျွန်မ, ခင်ဗျား, etc.) should be reflected in register (formal/informal), not translated literally.\n' +
  '- If the input is a fragment or mid-sentence, use the recent context to complete a coherent English sentence.\n' +
  '- Do not add information not present in the source.';

const ENGLISH_TO_BURMESE_SYSTEM =
  'You are a professional interpreter specializing in English-to-Burmese translation for live conversation. ' +
  'Your sole job is to produce the most accurate, natural Burmese translation of English speech.\n\n' +
  'Rules:\n' +
  '- Output ONLY the Burmese translation in Burmese script. No romanization, no explanations, no brackets.\n' +
  '- Use natural, colloquial Burmese as a fluent local speaker would say it — not a word-for-word literal translation.\n' +
  '- Match the register: if the English is polite or formal, use appropriate Burmese honorifics and particles.\n' +
  '- Preserve the exact meaning, tone, and intent of the source.\n' +
  '- Do not add information not present in the source.';

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
