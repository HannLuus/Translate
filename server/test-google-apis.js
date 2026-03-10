#!/usr/bin/env node
/**
 * Test Google Cloud APIs (Speech-to-Text, Text-to-Speech, Vertex AI Gemini)
 * using the same credentials as the server. Run from server dir:
 *   node test-google-apis.js
 * Requires .env with GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS_JSON.
 * Optional VERTEX_AI_REGION (default us-central1) for Vertex AI test.
 */
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    JSON.parse(raw); // validate JSON before writing
    const credentialsPath = path.join(os.tmpdir(), `google-credentials-test-${process.pid}.json`);
    fs.writeFileSync(credentialsPath, raw, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error('GOOGLE_APPLICATION_CREDENTIALS_JSON is invalid JSON:', err.message);
      console.error('Use the full service account JSON in one line (no truncation or literal "...").');
    } else {
      console.error('Failed to write credentials to temp file:', err.message);
    }
    process.exit(1);
  }
}

const { v2 } = require('@google-cloud/speech');
const textToSpeech = require('@google-cloud/text-to-speech');
const { VertexAI } = require('@google-cloud/vertexai');

async function getProjectId() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) {
    try {
      const key = fs.readFileSync(keyPath, 'utf8');
      const parsed = JSON.parse(key);
      return parsed.project_id;
    } catch (_) {
      // ignore
    }
  }
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

async function testSpeechToText() {
  console.log('\n1. Testing Speech-to-Text (recognize)...');
  const projectId = await getProjectId();
  if (!projectId) {
    console.log('   SKIP: No project ID (set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS_JSON)');
    return;
  }
  const speechRegion = 'asia-southeast1';
  const client = new v2.SpeechClient({ apiEndpoint: `${speechRegion}-speech.googleapis.com` });
  const recognizer = `projects/${projectId}/locations/${speechRegion}/recognizers/_`;
  const protos = require('@google-cloud/speech').protos;
  const Encoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;
  // Minimal 16kHz LINEAR16 audio: 0.2 sec = 6400 bytes (silence)
  const silentBuffer = Buffer.alloc(6400, 0);
  const models = ['chirp_3', 'chirp_2'];
  for (const model of models) {
    try {
      const [response] = await client.recognize({
        recognizer,
        config: {
          model,
          languageCodes: ['my-MM'],
          explicitDecodingConfig: {
            encoding: Encoding.LINEAR16,
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
        },
        configMask: { paths: ['model', 'language_codes', 'explicit_decoding_config'] },
        content: silentBuffer,
      });
      const transcript = response?.results
        ?.map((r) => r.alternatives?.[0]?.transcript)
        .filter(Boolean)
        .join(' ')
        .trim();
      console.log(`   OK: Speech-to-Text (model: ${model}, transcript:`, transcript || '(empty/silence)', ')');
      break;
    } catch (err) {
      const msg = err.message || String(err);
      const isUnsupported =
        msg.includes('not found') ||
        msg.includes('not exist') ||
        msg.includes('not supported') ||
        msg.includes('unsupported') ||
        msg.includes('invalid');
      if (model === 'chirp_3' && isUnsupported) {
        console.log(`   WARN: ${model} rejected (${msg}), retrying with chirp_2...`);
        continue;
      }
      console.log('   FAIL:', msg);
      break;
    }
  }
}

async function testTextToSpeech() {
  console.log('\n2. Testing Text-to-Speech (synthesize)...');
  const client = new textToSpeech.TextToSpeechClient();
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text: 'Test' },
      voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
      audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
    });
    const size = response.audioContent ? response.audioContent.length : 0;
    console.log('   OK: Text-to-Speech (audio bytes:', size, ')');
  } catch (err) {
    console.log('   FAIL:', err.message || err);
  }
}

async function testVertexAI() {
  const projectId = await getProjectId();
  if (!projectId) {
    console.log('\n3. Vertex AI: SKIP (no project ID; set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_PROJECT)');
    return;
  }
  console.log('\n3. Testing Vertex AI (Gemini)...');
  try {
    const region = process.env.VERTEX_AI_REGION || 'us-central1';
    const vertexAI = new VertexAI({ project: projectId, location: region });
    const model = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
    });
    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log('   OK: Vertex AI Gemini (reply:', text || '(empty)', ')');
  } catch (err) {
    console.log('   FAIL:', err.message || err);
  }
}

async function main() {
  console.log('Google Cloud API tests (same credentials as server)');
  await testSpeechToText();
  await testTextToSpeech();
  await testVertexAI();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
