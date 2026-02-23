#!/usr/bin/env node
/**
 * Test Google Cloud APIs (Speech-to-Text, Text-to-Speech, optional Gemini)
 * using the same credentials as the server. Run from server dir:
 *   node test-google-apis.js
 * Requires .env with GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS_JSON,
 * and GEMINI_API_KEY for the Gemini test.
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
  const client = new v2.SpeechClient();
  const recognizer = `projects/${projectId}/locations/us/recognizers/_`;
  const protos = require('@google-cloud/speech').protos;
  const Encoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;
  // Minimal 16kHz LINEAR16 audio: 0.2 sec = 6400 bytes (silence)
  const silentBuffer = Buffer.alloc(6400, 0);
  try {
    const [response] = await client.recognize({
      recognizer,
      config: {
        model: 'chirp_3',
        languageCodes: ['my-MM'],
        explicitDecodingConfig: {
          encoding: Encoding.LINEAR16,
          sampleRateHertz: 16000,
        },
      },
      content: silentBuffer,
    });
    const transcript = response?.results
      ?.map((r) => r.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(' ')
      .trim();
    console.log('   OK: Speech-to-Text (transcript:', transcript || '(empty/silence)', ')');
  } catch (err) {
    console.log('   FAIL:', err.message || err);
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

async function testGemini() {
  if (!process.env.GEMINI_API_KEY) {
    console.log('\n3. Gemini: SKIP (GEMINI_API_KEY not set)');
    return;
  }
  console.log('\n3. Testing Gemini...');
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent('Reply with exactly: OK');
    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log('   OK: Gemini (reply:', text || '(empty)', ')');
  } catch (err) {
    console.log('   FAIL:', err.message || err);
  }
}

async function main() {
  console.log('Google Cloud API tests (same credentials as server)');
  await testSpeechToText();
  await testTextToSpeech();
  await testGemini();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
