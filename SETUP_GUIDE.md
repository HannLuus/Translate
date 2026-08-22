# Complete Setup Guide: Google Cloud & Supabase Configuration

This guide will help you set up your Google Cloud project and configure Supabase Edge Functions with the correct API keys and credentials.

## Prerequisites

- ✅ You have a working Gemini API key from your Google developer account
- ✅ Access to Google Cloud Console (https://console.cloud.google.com)
- ✅ Access to Supabase Dashboard (https://supabase.com/dashboard)

---

## Part 1: Google Cloud Setup

### Step 1: Enable Billing on Your Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project (or create a new one if needed)
3. Navigate to **Billing** → **Link a billing account**
4. If you don't have a billing account:
   - Click **Create billing account**
   - Fill in your payment information
   - **Important**: Even with billing enabled, Google Cloud has a free tier that covers reasonable usage

### Step 2: Enable Required APIs

Your app needs these Google Cloud APIs:

1. **Gemini API** (for translation)
2. **Cloud Speech-to-Text API** (for transcribing audio)
3. **Cloud Text-to-Speech API** (for generating speech)

**To enable them:**

1. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for and enable each API:
   - **"Generative Language API"** or **"Gemini API"** (for translation)
   - **"Cloud Speech-to-Text API"** (for audio transcription)
   - **"Cloud Text-to-Speech API"** (for speech synthesis)
3. For each API, click **Enable**

**Quick links:**
- [Enable Generative Language API](https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com)
- [Enable Speech-to-Text API](https://console.cloud.google.com/apis/library/speech.googleapis.com)
- [Enable Text-to-Speech API](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com)

### Step 3: Create a Service Account

The app needs a service account to access Speech-to-Text and Text-to-Speech APIs.

1. Go to [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click **+ CREATE SERVICE ACCOUNT**
3. Fill in:
   - **Service account name**: `interpreter-service` (or any name you prefer)
   - **Service account ID**: auto-generated (you can change it)
   - Click **CREATE AND CONTINUE**
4. **Grant access** (optional for now, we'll use API keys):
   - Click **CONTINUE** (skip role assignment)
   - Click **DONE**

### Step 4: Create Service Account Key (JSON)

1. In the Service Accounts list, click on the service account you just created
2. Go to the **KEYS** tab
3. Click **ADD KEY** → **Create new key**
4. Select **JSON** format
5. Click **CREATE**
6. **Important**: The JSON file will download automatically. **Keep this file secure!**

### Step 5: Grant API Permissions to Service Account

1. Go back to [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click on your service account
3. Go to the **PERMISSIONS** tab
4. Click **GRANT ACCESS**
5. Add these roles:
   - **Cloud Speech Client** (for Speech-to-Text)
   - **Cloud Text-to-Speech Client** (for Text-to-Speech)
6. Click **SAVE**

**Alternative method (if roles don't appear):**
- The service account should work with just the API key, but if you encounter permission errors, you can grant:
  - **Service Account User**
  - Or create a custom role with permissions for `speech.googleapis.com` and `texttospeech.googleapis.com`

### Step 6: Verify Your Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Verify your API key is listed and active
3. **Important**: Make sure the API key is associated with a project that has:
   - ✅ Billing enabled
   - ✅ Generative Language API enabled

---

## Part 2: Supabase Configuration

### Step 1: Access Supabase Edge Functions Secrets

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project (project ref: `hbeixuedkdugfrpwpdph`)
3. Navigate to **Project Settings** → **Edge Functions** → **Secrets**

### Step 2: Set GEMINI_API_KEY

1. In the Secrets section, find or create: `GEMINI_API_KEY`
2. Paste your Gemini API key (the one from your developer account)
3. Click **Save** or **Add secret**

**Your Gemini API key should look like:** `AIza...` (starts with "AIza")

### Step 3: Set GOOGLE_APPLICATION_CREDENTIALS_JSON

1. Open the JSON file you downloaded in Step 4 of Part 1
2. Copy the **entire contents** of the JSON file
3. In Supabase Secrets, find or create: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
4. Paste the **entire JSON** (it should look like):
   ```json
   {
     "type": "service_account",
     "project_id": "your-project-id",
     "private_key_id": "...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "...",
     ...
   }
   ```
5. Click **Save** or **Add secret**

**Important Notes:**
- Paste the **entire JSON** as a single string
- Supabase will handle the formatting
- Make sure there are no extra spaces or line breaks that break the JSON

---

## Part 3: Verify the Setup

### Test 1: Verify Secrets Are Set

1. In Supabase Dashboard → Edge Functions → Secrets
2. Verify both secrets exist:
   - ✅ `GEMINI_API_KEY`
   - ✅ `GOOGLE_APPLICATION_CREDENTIALS_JSON`

### Test 2: Test the Health Endpoint

The health endpoint should work (it doesn't use these APIs), but you can test:
```bash
curl https://hbeixuedkdugfrpwpdph.supabase.co/functions/v1/health \
  -H "apikey: sb_publishable_RZ_ZRT_WlrPdfxuAscHE0w_p96zEzI9" \
  -H "Authorization: Bearer sb_publishable_RZ_ZRT_WlrPdfxuAscHE0w_p96zEzI9"
```

Expected response: `{"ok":true}`

### Test 3: Test the App

1. Open your app in the browser
2. The "Backend connected" status should show
3. Try starting interpretation
4. If you still see errors, check the browser console for specific error messages

---

## Troubleshooting

### Error: "GEMINI_API_KEY is not set"
- ✅ Verify the secret is set in Supabase Dashboard → Edge Functions → Secrets
- ✅ Make sure the secret name is exactly `GEMINI_API_KEY` (case-sensitive)
- ✅ After adding/updating secrets, wait 1-2 minutes for them to propagate

### Error: "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set"
- ✅ Verify the secret is set in Supabase Dashboard → Edge Functions → Secrets
- ✅ Make sure you pasted the **entire JSON** (not just part of it)
- ✅ Verify the JSON is valid (you can test it at https://jsonlint.com)

### Error: "Translation quota or API key issue"
- ✅ Verify billing is enabled on your Google Cloud project
- ✅ Verify the Gemini API key is from a project with billing enabled
- ✅ Check your Google Cloud billing account is active
- ✅ Verify Generative Language API is enabled

### Error: "Speech API error" or "TTS error"
- ✅ Verify Cloud Speech-to-Text API is enabled
- ✅ Verify Cloud Text-to-Speech API is enabled
- ✅ Verify the service account JSON is correct
- ✅ Verify the service account has the necessary permissions

### Error: 503 Service Unavailable
- This usually means one of the APIs failed
- Check the Supabase Edge Functions logs:
  1. Go to Supabase Dashboard → Edge Functions → Logs
  2. Look for error messages related to your requests
  3. The logs will show which API call failed

---

## Quick Checklist

Before testing your app, verify:

- [ ] Billing is enabled on Google Cloud project
- [ ] Generative Language API (Gemini) is enabled
- [ ] Cloud Speech-to-Text API is enabled
- [ ] Cloud Text-to-Speech API is enabled
- [ ] Service account is created
- [ ] Service account JSON key is downloaded
- [ ] `GEMINI_API_KEY` is set in Supabase Edge Functions Secrets
- [ ] `GOOGLE_APPLICATION_CREDENTIALS_JSON` is set in Supabase Edge Functions Secrets (full JSON)
- [ ] Waited 1-2 minutes after setting secrets for them to propagate

---

## Next Steps

After completing this setup:

1. **Wait 1-2 minutes** for Supabase secrets to propagate
2. **Refresh your app** in the browser
3. **Try starting interpretation** - it should work now!
4. If you still see errors, check the browser console and Supabase Edge Functions logs

---

## Need Help?

If you encounter issues:

1. Check the browser console for specific error messages
2. Check Supabase Edge Functions logs for backend errors
3. Verify all APIs are enabled in Google Cloud Console
4. Verify billing is active and not suspended
5. Make sure your Gemini API key is from the correct project
