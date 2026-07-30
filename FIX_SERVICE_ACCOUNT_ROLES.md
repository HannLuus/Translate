# Fix: Assign Roles to Service Account (Not Your Personal Account)

## The Problem

You're assigning roles to your personal account (`Hann.luus@gmail.com`), but your app uses a **service account** to make API calls. The service account needs the permissions, not your personal account.

## Step 1: Find Your Service Account Email

1. Go to [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Make sure you're in the **"Burmese-interpreter"** project
3. Find the service account you created (the one you downloaded the JSON for)
4. **Copy the service account email** - it looks like:
   - `interpreter-service@burmese-interpreter.iam.gserviceaccount.com`
   - Or similar: `your-service-account-name@your-project-id.iam.gserviceaccount.com`

## Step 2: Grant Roles to the Service Account

1. Go to [Google Cloud Console → IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam)
2. Make sure you're in the **"Burmese-interpreter"** project
3. Click **"+ GRANT ACCESS"** (top of the page)
4. In **"New principals"**, paste your **service account email** (not your personal email!)
5. In **"Select a role"**, add these roles:

   **For Speech-to-Text:**
   - ✅ **Cloud Speech Client** (`roles/cloudspeech.client`)
   - OR **Cloud Speech Administrator** (`roles/speech.admin`) - if you want admin access

   **For Text-to-Speech:**
   - ✅ **Text-to-Speech Editor** (`roles/texttospeech.editor`)
   - OR search for "Text-to-Speech" and select the Editor role

6. Click **"SAVE"**

## Step 3: Verify the Service Account Has Roles

1. Stay on the IAM page
2. In the filter/search box, type your **service account email**
3. You should see the service account listed with the roles you just added
4. If you see your personal account (`Hann.luus@gmail.com`), that's different - the service account needs its own roles

## Important Notes

- **Service account email** ≠ **Your personal email**
- The service account email ends with `.iam.gserviceaccount.com`
- Your personal email is `Hann.luus@gmail.com`
- The app uses the service account (from the JSON file), so that's what needs permissions

## Quick Checklist

- [ ] Found your service account email (ends with `.iam.gserviceaccount.com`)
- [ ] Granted `Cloud Speech Client` or `Cloud Speech Administrator` to service account
- [ ] Granted `Text-to-Speech Editor` to service account
- [ ] Verified service account appears in IAM list with these roles
- [ ] Waited 1-2 minutes for permissions to propagate

## Alternative: If Text-to-Speech Editor Doesn't Work

If you can't find "Text-to-Speech Editor" role, try:
1. Make sure **Cloud Text-to-Speech API is enabled** in your project
2. The service account might work with just the `cloud-platform` scope (which your code already uses)
3. Try testing the app - if Text-to-Speech works, you might not need a specific role for it

The most important one is **Cloud Speech Client** for the Speech-to-Text API, which is what's currently failing.
