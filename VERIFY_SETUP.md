# Quick Verification: Is Your Setup Correct?

Follow these steps to verify your configuration is correct.

## ✅ Step 1: Check Supabase Secrets (MOST IMPORTANT)

1. Go to: https://supabase.com/dashboard/project/hbeixuedkdugfrpwpdph/settings/functions
2. Scroll down to **Secrets** section
3. **You MUST see these two secrets:**

   **Secret 1:**
   - Name: `GEMINI_API_KEY`
   - Value: Should show `AIza...` (partially hidden for security)
   - ✅ If missing: Click **Add secret** → Name: `GEMINI_API_KEY` → Paste your key → Save

   **Secret 2:**
   - Name: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
   - Value: Should show `{"type":"service_account"...}` (partially hidden)
   - ✅ If missing: Click **Add secret** → Name: `GOOGLE_APPLICATION_CREDENTIALS_JSON` → Paste full JSON → Save

## ✅ Step 2: Check Supabase Logs (THIS WILL SHOW THE REAL ERROR)

1. Go to: https://supabase.com/dashboard/project/hbeixuedkdugfrpwpdph/functions
2. Click on **Logs** tab
3. Look for **red error messages** from the `interpret` function
4. **The error message will tell you exactly what's wrong!**

   Common errors you might see:
   - `GEMINI_API_KEY is not set` → Secret not found
   - `Translation quota or API key issue` → Billing not enabled
   - `GOOGLE_APPLICATION_CREDENTIALS_JSON is not set` → Service account missing
   - `Speech API error: ...` → Service account or API issue

## ✅ Step 3: Verify Gemini API Key Has Billing

1. Go to: https://aistudio.google.com/apikey
2. Find your API key (the one you put in Supabase)
3. Note which Google Cloud project it's from
4. Go to: https://console.cloud.google.com
5. Select that project
6. Go to **Billing** → **Link a billing account**
7. **Make sure billing is ACTIVE** (not just linked, but active)

## ✅ Step 4: Verify APIs Are Enabled

1. Go to: https://console.cloud.google.com/apis/library
2. Make sure you're in the correct project
3. Search for and verify these are **ENABLED**:
   - ✅ Generative Language API
   - ✅ Cloud Speech-to-Text API  
   - ✅ Cloud Text-to-Speech API

## 🔍 What to Do Next

1. **First**: Check Supabase logs (Step 2) - this will show the exact error
2. **Second**: Verify secrets are set (Step 1)
3. **Third**: Verify billing is enabled (Step 3)
4. **After making changes**: Wait 1-2 minutes, then refresh your app

## 📋 Quick Checklist

Before testing again, make sure:

- [ ] `GEMINI_API_KEY` secret exists in Supabase (exact name, case-sensitive)
- [ ] `GOOGLE_APPLICATION_CREDENTIALS_JSON` secret exists in Supabase (exact name)
- [ ] Gemini API key is from a project with **active billing**
- [ ] All 3 Google Cloud APIs are enabled
- [ ] You've waited 1-2 minutes after setting/updating secrets

## 🆘 Still Not Working?

**Share the error message from Supabase logs** (Step 2) and I can help you fix it!

The logs will show something like:
- `Error: GEMINI_API_KEY is not set`
- `Error: Translation quota or API key issue`
- `Error: Speech API error: ...`

Copy that exact error message and we can fix it!
