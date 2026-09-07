# Fix: Permission Denied Error for Speech-to-Text API

## The Problem

You're getting this error:
```
Permission 'speech.recognizers.recognize' denied on resource
```

This means your service account doesn't have the right IAM permissions to use the Speech-to-Text API.

## The Solution: Grant IAM Roles to Service Account

### Step 1: Find Your Service Account Email

1. Go to [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Find the service account you created (the one you downloaded the JSON for)
3. **Copy the service account email** (it looks like: `interpreter-service@your-project-id.iam.gserviceaccount.com`)

### Step 2: Grant Required IAM Roles

1. Go to [Google Cloud Console → IAM & Admin → IAM](https://console.cloud.google.com/iam-admin/iam)
2. Make sure you're in the **correct project** (the one your service account is from)
3. Click **"+ GRANT ACCESS"** (top of the page)
4. In the **"New principals"** field, paste your service account email
5. In the **"Select a role"** dropdown, add these roles (click "ADD ANOTHER ROLE" for each):

   **Required Roles:**
   - ✅ **Cloud Speech Client** (`roles/cloudspeech.client`)
   - ✅ **Cloud Text-to-Speech Client** (`roles/cloudtexttospeech.client`)

6. Click **"SAVE"**

### Step 3: Verify APIs Are Enabled

Make sure these APIs are enabled in your project:

1. Go to [APIs & Services → Enabled APIs](https://console.cloud.google.com/apis/library)
2. Verify these are enabled:
   - ✅ **Cloud Speech-to-Text API** (`speech.googleapis.com`)
   - ✅ **Cloud Text-to-Speech API** (`texttospeech.googleapis.com`)

If not enabled:
- Search for "Cloud Speech-to-Text API" → Click → **Enable**
- Search for "Cloud Text-to-Speech API" → Click → **Enable**

### Step 4: Wait and Test

1. **Wait 1-2 minutes** for IAM permissions to propagate
2. **Refresh your app** in the browser
3. **Try again** - the permission error should be gone!

## Alternative: Use Predefined Roles

If you can't find the specific roles above, you can use these broader roles (less secure, but works):

- **Cloud Speech Client** → Use **"Service Account User"** (`roles/iam.serviceAccountUser`)
- Or use **"Cloud Platform"** scope (already in your code, but needs the IAM role)

## Quick Checklist

- [ ] Found your service account email
- [ ] Granted `roles/cloudspeech.client` role to service account
- [ ] Granted `roles/cloudtexttospeech.client` role to service account
- [ ] Verified Speech-to-Text API is enabled
- [ ] Verified Text-to-Speech API is enabled
- [ ] Waited 1-2 minutes for permissions to propagate
- [ ] Tested the app again

## Still Not Working?

If you still get permission errors:

1. **Double-check the project**: Make sure the service account is from the same project where you enabled the APIs
2. **Check IAM**: Go to IAM page and verify the service account email has the roles listed
3. **Wait longer**: Sometimes IAM changes take 5-10 minutes to propagate

## About MCP Logs

I don't have direct MCP access to Supabase logs, but you can check them at:
- https://supabase.com/dashboard/project/hbeixuedkdugfrpwpdph/functions/interpret/logs

The logs will show the exact error messages, which is how we found this permission issue!
