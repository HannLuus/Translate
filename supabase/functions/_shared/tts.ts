import { getAccessToken } from './googleAuth.ts';

const TTS_MAX_BYTES = 4500;

function truncateForTts(text: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= TTS_MAX_BYTES) return text;
  const truncated = new TextDecoder().decode(bytes.slice(0, TTS_MAX_BYTES));
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > TTS_MAX_BYTES / 2 ? truncated.slice(0, lastSpace) : truncated;
}

export async function synthesizeSpeech(
  text: string,
  languageCode: 'en-US' | 'my-MM',
): Promise<string | null> {
  const safeText = truncateForTts(text);
  if (!safeText) return null;

  const token = await getAccessToken();
  const lang = languageCode.startsWith('my') ? 'my-MM' : 'en-US';
  const voiceName = lang === 'my-MM' ? 'my-MM-Standard-A' : 'en-US-Neural2-D';

  const body = {
    input: { text: safeText },
    voice: { languageCode: lang, name: voiceName },
    audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
  };

  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    if (err.includes('voice')) {
      // Fallback: let Google pick the voice
      const fallbackBody = {
        input: { text: safeText },
        voice: { languageCode: lang },
        audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
      };
      const fallbackRes = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fallbackBody),
      });
      if (!fallbackRes.ok) throw new Error(`TTS fallback error: ${await fallbackRes.text()}`);
      const fallbackData = await fallbackRes.json() as { audioContent?: string };
      return fallbackData.audioContent ?? null;
    }
    throw new Error(`TTS error: ${err}`);
  }

  const data = await res.json() as { audioContent?: string };
  return data.audioContent ?? null;
}
