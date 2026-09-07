# Troubleshooting: 503 Service Unavailable Error

You're getting a 503 error which means the Supabase Edge Function is failing. Let's verify your setup step by step.

## Step 1: Verify Secrets Are Set in Supabase

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project: `hbeixuedkdugfrpwpdph`
3. Navigate to **Project Settings** → **Edge Functions** → **Secrets**
4. **Verify these two secrets exist:**

   ✅ **GEMINI_API_KEY**
   - Should be visible in the list
   - Value should start with `AIza...`
   - If missing or wrong, click **Add secret** or **Edit**

   ✅ **GOOGLE_APPLICATION_CREDENTIALS_JSON**
   - Should be visible in the list
   - Value should be a JSON object starting with `{"type":"service_account"...}`
   - If missing, you need to add the service account JSON

## Step 2: Check Supabase Edge Functions Logs

The logs will show the **actual error** that's causing the 503:

1. In Supabase Dashboard, go to **Edge Functions** → **Logs**
2. Look for recent errors (red entries) from the `interpret` function
3. The error message will tell you exactly what's wrong:
   - `GEMINI_API_KEY is not set` → Secret not set or wrong name
   - `Translation quota or API key issue` → Billing not enabled or quota exceeded
   - `Speech API error` → Service account issue
   - `GOOGLE_APPLICATION_CREDENTIALS_JSON is not set` → Service account JSON missing

## Step 3: Verify Gemini API Key Has Billing Enabled

Even if you set the secret, the API key must be from a project with billing enabled:

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Find your API key
3. Click on it to see which project it's associated with
4. Go to [Google Cloud Console](https://console.cloud.google.com)
5. Select that project
6. Go to **Billing** → Verify billing account is linked and active

## Step 4: Verify Google Cloud APIs Are Enabled

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Go to **APIs & Services** → **Enabled APIs**
4. Verify these are enabled:
   - ✅ **Generative Language API** (for Gemini)
   - ✅ **Cloud Speech-to-Text API**
   - ✅ **Cloud Text-to-Speech API**

## Step 5: Test the Secrets Manually

You can test if the secrets are accessible by checking the Supabase logs when the function runs. But first, let's verify the secret names are **exactly** correct:

- ✅ `GEMINI_API_KEY` (not `gemini_api_key` or `GEMINI-API-KEY`)
- ✅ `GOOGLE_APPLICATION_CREDENTIALS_JSON` (not `GOOGLE_APPLICATION_CREDENTIALS`)

## Common Issues & Solutions

### Issue: "GEMINI_API_KEY is not set"
**Solution:**
1. Go to Supabase → Edge Functions → Secrets
2. Check if `GEMINI_API_KEY` exists (case-sensitive!)
3. If it doesn't exist, click **Add secret**
4. Name: `GEMINI_API_KEY`
5. Value: Your API key (starts with `AIza...`)
6. Click **Save**
7. **Wait 1-2 minutes** for the secret to propagate

### Issue: "Translation quota or API key issue"
**Possible causes:**
1. **Billing not enabled** on the Google Cloud project
   - Solution: Enable billing in Google Cloud Console
2. **API key from wrong project**
   - Solution: Make sure the API key is from the project with billing enabled
3. **Quota exceeded**
   - Solution: Check Google Cloud Console → APIs & Services → Quotas

### Issue: "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set"
**Solution:**
1. Go to Supabase → Edge Functions → Secrets
2. Add secret: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
3. Value: Paste the **entire** service account JSON (from the file you downloaded)
4. Make sure it's valid JSON (starts with `{` and ends with `}`)

### Issue: "Speech API error" or "TTS error"
**Solution:**
1. Verify `GOOGLE_APPLICATION_CREDENTIALS_JSON` is set correctly
2. Verify Speech-to-Text and Text-to-Speech APIs are enabled
3. Verify the service account has permissions

## Quick Verification Checklist

Before testing again, verify:

- [ ] `GEMINI_API_KEY` exists in Supabase Edge Functions Secrets
- [ ] `GOOGLE_APPLICATION_CREDENTIALS_JSON` exists in Supabase Edge Functions Secrets
- [ ] Gemini API key starts with `AIza...`
- [ ] Service account JSON is valid (starts with `{"type":"service_account"...}`)
- [ ] Billing is enabled on Google Cloud project
- [ ] Generative Language API is enabled
- [ ] Speech-to-Text API is enabled
- [ ] Text-to-Speech API is enabled
- [ ] Waited 1-2 minutes after setting/updating secrets

## Next Steps

1. **Check Supabase Logs** first - they'll show the exact error
2. **Verify secrets are set** (Step 1 above)
3. **Verify billing is enabled** (Step 3 above)
4. **Wait 1-2 minutes** after any changes
5. **Refresh your app** and try again

If you're still stuck, share the error message from the Supabase Edge Functions logs, and I can help you fix it!
