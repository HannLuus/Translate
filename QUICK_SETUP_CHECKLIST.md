# Quick Setup Checklist

Follow these steps in order to fix the connection issue.

## Google Cloud Setup (15-20 minutes)

### 1. Enable Billing
- [ ] Go to https://console.cloud.google.com
- [ ] Select your project
- [ ] Navigate to **Billing** → Link/create billing account
- [ ] Verify billing is active

### 2. Enable APIs
Enable these three APIs in Google Cloud Console → APIs & Services → Library:

- [ ] **Generative Language API** (Gemini)
  - Link: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com
- [ ] **Cloud Speech-to-Text API**
  - Link: https://console.cloud.google.com/apis/library/speech.googleapis.com
- [ ] **Cloud Text-to-Speech API**
  - Link: https://console.cloud.google.com/apis/library/texttospeech.googleapis.com

### 3. Create Service Account
- [ ] Go to IAM & Admin → Service Accounts
- [ ] Click **+ CREATE SERVICE ACCOUNT**
- [ ] Name it (e.g., `interpreter-service`)
- [ ] Click **CREATE AND CONTINUE** → **DONE**

### 4. Download Service Account Key
- [ ] Click on the service account you created
- [ ] Go to **KEYS** tab
- [ ] Click **ADD KEY** → **Create new key** → **JSON**
- [ ] **SAVE THE DOWNLOADED JSON FILE** (you'll need it in Supabase)

## Supabase Setup (5 minutes)

### 1. Access Secrets
- [ ] Go to https://supabase.com/dashboard
- [ ] Select project: `hbeixuedkdugfrpwpdph`
- [ ] Navigate to **Project Settings** → **Edge Functions** → **Secrets**

### 2. Add GEMINI_API_KEY
- [ ] Click **Add secret** (or edit if exists)
- [ ] Name: `GEMINI_API_KEY`
- [ ] Value: Paste your Gemini API key (starts with `AIza...`)
- [ ] Click **Save**

### 3. Add GOOGLE_APPLICATION_CREDENTIALS_JSON
- [ ] Click **Add secret** (or edit if exists)
- [ ] Name: `GOOGLE_APPLICATION_CREDENTIALS_JSON`
- [ ] Value: Open the JSON file you downloaded, copy **ALL** of it, and paste here
- [ ] Click **Save**

## Verify & Test (2 minutes)

- [ ] Wait 1-2 minutes for secrets to propagate
- [ ] Refresh your app in the browser
- [ ] Check that "Backend connected" shows (green)
- [ ] Try clicking "Start interpretation"
- [ ] If errors persist, check browser console (F12) for details

## Common Issues

**"GEMINI_API_KEY is not set"**
→ Check secret name is exactly `GEMINI_API_KEY` (case-sensitive)

**"Translation quota or API key issue"**
→ Verify billing is enabled on Google Cloud project

**"Speech API error"**
→ Verify Speech-to-Text and Text-to-Speech APIs are enabled

**503 Service Unavailable**
→ Check Supabase Edge Functions logs for specific error

---

**Full detailed guide:** See `SETUP_GUIDE.md`
