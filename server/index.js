require('dotenv').config();

// Support inline JSON credentials: use GOOGLE_APPLICATION_CREDENTIALS_JSON if no file path is set (e.g. Supabase Edge Functions, or server/.env)
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
const { VertexAI } = require('@google-cloud/vertexai');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;

let speechClient;
let ttsClient;
let vertexAI;

const SPEECH_REGION = 'asia-southeast1'; // Singapore – lowest latency for Myanmar/Mandalay
const VERTEX_REGION = process.env.VERTEX_AI_REGION || 'us-central1';

function getSpeechClient() {
  if (!speechClient) {
    speechClient = new v2.SpeechClient({ apiEndpoint: `${SPEECH_REGION}-speech.googleapis.com` });
  }
  return speechClient;
}

function getTtsClient() {
  if (!ttsClient) {
    ttsClient = new textToSpeech.TextToSpeechClient();
  }
  return ttsClient;
}

async function getVertexAI() {
  if (vertexAI) return vertexAI;
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Vertex AI requires GOOGLE_APPLICATION_CREDENTIALS (or GOOGLE_CLOUD_PROJECT) with project_id');
  vertexAI = new VertexAI({ project: projectId, location: VERTEX_REGION });
  return vertexAI;
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
  'You are a live interpreter. Translate the Burmese to natural, fluent English.\n\n' +
  'Rules: Use complete, well-formed sentences. Preserve tone and connotation (formal, casual, question, etc.). ' +
  'If the current Burmese is a fragment or mid-sentence, combine it with the recent context to produce one coherent English sentence where possible. ' +
  'Output only the translation, no explanations or brackets.';

const ENGLISH_TO_BURMESE_PROMPT =
  'Translate this English dialogue to natural Burmese for a local speaker to hear. Output only the translation, no explanations.';

function buildTranslationPrompt(promptBase, currentText, recentContext) {
  if (!recentContext || !recentContext.trim()) return `${promptBase}\n\nCurrent to translate: ${currentText.trim()}`;
  return `${promptBase}\n\nRecent translation (for continuity): ${recentContext.trim()}\n\nCurrent to translate: ${currentText.trim()}`;
}

// 16kHz mono 16-bit: ~0.5s minimum to avoid Speech API INVALID_ARGUMENT on very short audio
const MIN_AUDIO_BYTES = 16000 * 0.5 * 2; // 16000 samples/sec * 0.5s * 2 bytes

async function transcribeWithChirp3(audioBuffer) {
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  if (buf.length < MIN_AUDIO_BYTES) {
    return '';
  }
  const projectId = await getProjectId();
  if (!projectId) throw new Error('Missing GOOGLE_CLOUD_PROJECT or GOOGLE_APPLICATION_CREDENTIALS with project_id');
  const recognizer = `projects/${projectId}/locations/${SPEECH_REGION}/recognizers/_`;
  const client = getSpeechClient();
  const protos = require('@google-cloud/speech').protos;
  const Encoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;
  const explicitDecodingConfig = {
    encoding: Encoding.LINEAR16,
    sampleRateHertz: 16000,
    audioChannelCount: 1,
  };
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

async function translateWithGemini(text, toEnglish = true, recentContext = null) {
  if (!text || typeof text !== 'string' || !text.trim()) return '';
  const ai = await getVertexAI();
  const promptBase = toEnglish ? BURMESE_TO_ENGLISH_PROMPT : ENGLISH_TO_BURMESE_PROMPT;
  const userMessage = buildTranslationPrompt(promptBase, text, recentContext);
  const model = ai.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: { parts: [{ text: promptBase }] },
  });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
  });
  const resp = result.response;
  if (!resp || !resp.candidates || !resp.candidates[0]) {
    const blockReason = resp?.promptFeedback?.blockReason ?? resp?.candidates?.[0]?.finishReason;
    throw new Error(blockReason ? `Vertex AI blocked: ${blockReason}` : 'Vertex AI returned no text');
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
  const voice = lang === 'my-MM' ? { languageCode: lang } : { languageCode: lang, name: 'en-US-Neural2-D' };
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text: safeText },
      voice,
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
    const recentContext = req.headers['x-translation-context'] && typeof req.headers['x-translation-context'] === 'string'
      ? req.headers['x-translation-context'].trim()
      : null;
    const burmeseText = await transcribeWithChirp3(audioBuffer);
    if (!burmeseText) {
      return res.json({ burmeseText: '', englishText: '', audioBase64: null });
    }
    const englishText = await translateWithGemini(burmeseText, true, recentContext);
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
  const recognizer = `projects/${projectId}/locations/${SPEECH_REGION}/recognizers/_`;
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
