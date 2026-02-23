require('dotenv').config();

// Support Render: use inline JSON env var if no credentials file path is set
const fs = require('fs');
const os = require('os');
const path = require('path');
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentialsPath = path.join(os.tmpdir(), `google-credentials-${process.pid}.json`);
    fs.writeFileSync(credentialsPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  } catch (err) {
    console.error('Failed to write GOOGLE_APPLICATION_CREDENTIALS_JSON to temp file:', err.message);
  }
}

const express = require('express');
const cors = require('cors');
const { v2 } = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;

let speechClient;
let ttsClient;
let genAI;

function getSpeechClient() {
  if (!speechClient) {
    // Chirp 3: available in US and EU only. We use the US endpoint; it works for this app.
    speechClient = new v2.SpeechClient({ apiEndpoint: 'us-speech.googleapis.com' });
  }
  return speechClient;
}

function getTtsClient() {
  if (!ttsClient) {
    ttsClient = new textToSpeech.TextToSpeechClient();
  }
  return ttsClient;
}

function getGenAI() {
  if (!genAI && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

async function getProjectId() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) {
    try {
      const key = require('fs').readFileSync(keyPath, 'utf8');
      const parsed = JSON.parse(key);
      return parsed.project_id;
    } catch (_) {
      // ignore
    }
  }
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

const BURMESE_TO_ENGLISH_PROMPT =
  'Translate this Burmese dialogue to natural English for an earbud feed. Output only the translation, no explanations.';
const ENGLISH_TO_BURMESE_PROMPT =
  'Translate this English dialogue to natural Burmese for a local speaker to hear. Output only the translation, no explanations.';

// 16kHz mono 16-bit: ~0.5s minimum to avoid Speech API INVALID_ARGUMENT on very short audio
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2; // 16000 samples/sec * 0.5s * 2 bytes

async function transcribeWithChirp3(audioBuffer) {
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  if (buf.length < MIN_AUDIO_BYTES) {
    return '';
  }
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Missing GOOGLE_CLOUD_PROJECT or GOOGLE_APPLICATION_CREDENTIALS with project_id');
  const recognizer = `projects/${projectId}/locations/us/recognizers/_`;
  const client = getSpeechClient();
  const protos = require('@google-cloud/speech').protos;
  const Encoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;
  const explicitDecodingConfig = {
    encoding: Encoding.LINEAR16,
    sampleRateHertz: 16000,
    audioChannelCount: 1,
  };
  // chirp_3 has limited language availability; fall back to chirp_2 if it rejects my-MM
  const models = ['chirp_3', 'chirp_2'];
  for (const model of models) {
    try {
      const [response] = await client.recognize({
        recognizer,
        config: {
          model,
          languageCodes: ['my-MM'],
          explicitDecodingConfig,
        },
        configMask: { paths: ['model', 'language_codes', 'explicit_decoding_config'] },
        content: buf,
      });
      const transcript = response?.results
        ?.map((r) => r.alternatives?.[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim();
      return transcript || '';
    } catch (err) {
      const msg = err.message || '';
      const isUnsupported =
        msg.includes('not found') ||
        msg.includes('not exist') ||
        msg.includes('not supported') ||
        msg.includes('unsupported') ||
        msg.includes('invalid');
      if (model === 'chirp_3' && isUnsupported) {
        console.warn(`[STT] ${model} rejected for my-MM, retrying with chirp_2: ${msg}`);
        continue;
      }
      throw err;
    }
  }
  return '';
}

async function translateWithGemini(text, toEnglish = true) {
  if (!text || typeof text !== 'string' || !text.trim()) return '';
  const ai = getGenAI();
  if (!ai) throw new Error('GEMINI_API_KEY not set');
  const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const prompt = toEnglish ? BURMESE_TO_ENGLISH_PROMPT : ENGLISH_TO_BURMESE_PROMPT;
  const result = await model.generateContent(`${prompt}\n\n${text.trim()}`);
  const resp = result.response;
  if (!resp || !resp.candidates || !resp.candidates[0]) {
    const blockReason = resp?.candidates?.[0]?.finishReason ?? resp?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `Gemini blocked: ${blockReason}` : 'Gemini returned no text');
  }
  const part = resp.candidates[0].content?.parts?.[0];
  return (part?.text || '').trim();
}

const TTS_MAX_BYTES = 4500;

function truncateForTts(text) {
  if (typeof text !== 'string') return '';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= TTS_MAX_BYTES) return text;
  const truncated = new TextDecoder().decode(bytes.slice(0, TTS_MAX_BYTES));
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > TTS_MAX_BYTES / 2 ? truncated.slice(0, lastSpace) : truncated;
}

async function synthesizeSpeech(text, languageCode = 'en-US') {
  const safeText = truncateForTts(text);
  if (!safeText) return null;
  const client = getTtsClient();
  const lang = languageCode.startsWith('my') ? 'my-MM' : 'en-US';
  const voiceName = languageCode.startsWith('my') ? 'my-MM-Standard-A' : 'en-US-Neural2-D';
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text: safeText },
      voice: { languageCode: lang, name: voiceName },
      audioConfig: {
        audioEncoding: 'MP3',
        sampleRateHertz: 24000,
      },
    });
    return response.audioContent;
  } catch (err) {
    if (err.message && err.message.includes('voice')) {
      const [fallback] = await client.synthesizeSpeech({
        input: { text: safeText },
        voice: { languageCode: lang },
        audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
      });
      return fallback.audioContent;
    }
    throw err;
  }
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body && typeof body === 'object' && body.byteLength !== undefined) {
    return Buffer.from(body);
  }
  return null;
}

app.post('/api/interpret', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const audioBuffer = toBuffer(req.body);
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Request body must be raw audio bytes' });
    }
    const burmeseText = await transcribeWithChirp3(audioBuffer);
    if (!burmeseText) {
      return res.json({ burmeseText: '', englishText: '', audioBase64: null });
    }
    const englishText = await translateWithGemini(burmeseText, true);
    const audioContent = await synthesizeSpeech(englishText, 'en-US');
    res.json({
      burmeseText,
      englishText,
      audioBase64: audioContent ? audioContent.toString('base64') : null,
    });
  } catch (err) {
    console.error('/api/interpret', err);
    res.status(500).json({ error: err.message || 'Interpret failed' });
  }
});

app.post('/api/response', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Request body must include { text: string }' });
    }
    const burmeseText = await translateWithGemini(text, false);
    const audioContent = await synthesizeSpeech(burmeseText, 'my-MM');
    res.json({
      burmeseText,
      audioBase64: audioContent ? audioContent.toString('base64') : null,
    });
  } catch (err) {
    console.error('/api/response', err);
    res.status(500).json({ error: err.message || 'Response failed' });
  }
});

async function transcribeEnglish(audioBuffer) {
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  if (buf.length < MIN_AUDIO_BYTES) {
    return '';
  }
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Missing GOOGLE_CLOUD_PROJECT or credentials');
  const recognizer = `projects/${projectId}/locations/us/recognizers/_`;
  const client = getSpeechClient();
  const protos = require('@google-cloud/speech').protos;
  const Encoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;
  const models = ['chirp_3', 'chirp_2'];
  for (const model of models) {
    try {
      const [response] = await client.recognize({
        recognizer,
        config: {
          model,
          languageCodes: ['en-US'],
          explicitDecodingConfig: {
            encoding: Encoding.LINEAR16,
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
        },
        configMask: { paths: ['model', 'language_codes', 'explicit_decoding_config'] },
        content: buf,
      });
      const transcript = response?.results
        ?.map((r) => r.alternatives?.[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim();
      return transcript || '';
    } catch (err) {
      const msg = err.message || '';
      const isUnsupported =
        msg.includes('not found') ||
        msg.includes('not exist') ||
        msg.includes('not supported') ||
        msg.includes('unsupported') ||
        msg.includes('invalid');
      if (model === 'chirp_3' && isUnsupported) {
        console.warn(`[STT] ${model} rejected for en-US, retrying with chirp_2: ${msg}`);
        continue;
      }
      throw err;
    }
  }
  return '';
}

app.post('/api/response-audio', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const audioBuffer = toBuffer(req.body);
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Request body must be raw audio bytes' });
    }
    const englishText = await transcribeEnglish(audioBuffer);
    if (!englishText) {
      return res.json({ englishText: '', burmeseText: '', audioBase64: null });
    }
    const burmeseText = await translateWithGemini(englishText, false);
    const audioContent = await synthesizeSpeech(burmeseText, 'my-MM');
    res.json({
      englishText,
      burmeseText,
      audioBase64: audioContent ? audioContent.toString('base64') : null,
    });
  } catch (err) {
    console.error('/api/response-audio', err);
    res.status(500).json({ error: err.message || 'Response audio failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
