# Quick Fix: Add Cloud Speech Client to Service Account

## Critical Step: Add Role to SERVICE ACCOUNT (Not Your Personal Account)

The permission error is happening because your **service account** doesn't have the right role. You need to add "Cloud Speech Client" to the **service account**, not your personal account.

## Step-by-Step:

### 1. Find Your Service Account Email

1. Go to: https://console.cloud.google.com/iam-admin/serviceaccounts
2. Select project: **"Burmese-interpreter"**
3. Find the service account you created (the one you downloaded the JSON for)
4. **Copy the service account email** - it looks like:
   - `something@burmese-interpreter.iam.gserviceaccount.com`

### 2. Grant "Cloud Speech Client" to Service Account

1. Go to: https://console.cloud.google.com/iam-admin/iam
2. Select project: **"Burmese-interpreter"**
3. Click **"+ GRANT ACCESS"**
4. In **"New principals"**, paste your **service account email** (the one ending in `.iam.gserviceaccount.com`)
5. In **"Select a role"**, search for and select:
   - **Cloud Speech Client** (`roles/cloudspeech.client`)
6. Click **"SAVE"**

### 3. Verify

1. On the IAM page, search for your service account email
2. You should see it listed with "Cloud Speech Client" role
3. Wait 1-2 minutes for permissions to propagate
4. Test your app again

## About Text-to-Speech

- If "Cloud Speech Administrator" covers Text-to-Speech (as you mentioned), great!
- If not, your code uses `cloud-platform` scope which might be sufficient
- Let's fix the Speech-to-Text error first, then test Text-to-Speech

## Important Reminder

- ✅ Add role to **service account** (ends with `.iam.gserviceaccount.com`)
- ❌ NOT your personal account (`Hann.luus@gmail.com`)

The service account is what your app uses (from the JSON file), so that's what needs the permission!
