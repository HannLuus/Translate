import { getAccessToken, getProjectId } from './googleAuth.ts';

const SPEECH_REGION = 'asia-southeast1';
// 16 kHz mono 16-bit: minimum 0.5 s to avoid INVALID_ARGUMENT
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2;

/** Encode bytes to base64 in chunks to avoid "Maximum call stack size exceeded". */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

async function recognizeAudio(
  audioBase64: string,
  languageCodes: string[],
): Promise<string> {
  const token = await getAccessToken();
  const projectId = getProjectId();
  const recognizer = `projects/${projectId}/locations/${SPEECH_REGION}/recognizers/_`;
  const url = `https://${SPEECH_REGION}-speech.googleapis.com/v2/${recognizer}:recognize`;

  const models = ['chirp_3', 'chirp_2'];
  for (const model of models) {
    const body = {
      config: {
        model,
        languageCodes,
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          audioChannelCount: 1,
        },
      },
      configMask: 'model,languageCodes,explicitDecodingConfig',
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

      if (model === 'chirp_3' && isUnsupported) {
        console.warn(`[STT] chirp_3 rejected, retrying with chirp_2: ${err}`);
        continue;
      }
      throw new Error(`Speech API error: ${err}`);
    }

    const data = await res.json() as {
      results?: { alternatives?: { transcript?: string }[] }[];
    };
    const transcript = (data.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
    return transcript;
  }
  return '';
}

export async function transcribeBurmese(audioBytes: Uint8Array): Promise<string> {
  if (audioBytes.length < MIN_AUDIO_BYTES) return '';
  const audioBase64 = bytesToBase64(audioBytes);
  return recognizeAudio(audioBase64, ['my-MM']);
}

export async function transcribeEnglish(audioBytes: Uint8Array): Promise<string> {
  if (audioBytes.length < MIN_AUDIO_BYTES) return '';
  const audioBase64 = bytesToBase64(audioBytes);
  return recognizeAudio(audioBase64, ['en-US']);
}
