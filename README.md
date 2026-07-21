# Burmese–English Interpreter PWA

Burmese-to-English meeting interpreter with three capture modes: **Desktop (Tab Audio)**, **Rooted Android (loopback)**, and **Face-to-Face (mic)**.

**Batch segments (default):** audio is captured continuously and closed every ~**3 minutes** (15 s overlap). Each segment is transcribed (ElevenLabs Scribe) and translated as a full passage (Gemini 2.5 Pro), then stitched in the UI — typically a few minutes behind live speech, by design, for better Burmese SOV accuracy. After the meeting, **Generate meeting minutes** builds a chronological record, decisions, and action items.

## Quick start

### Backend (Node)

```bash
cd server
cp .env.example .env
# Edit .env: set GOOGLE_APPLICATION_CREDENTIALS (Vertex AI uses same credentials; optional VERTEX_AI_REGION)
npm start
```

Runs on `http://localhost:3001`.

### Frontend (Vite PWA)

```bash
cd my-interpreter
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api` to the backend.

## Rooted Android (loopback device ID)

In **Rooted Android** mode the app captures audio from a **system loopback** device instead of the microphone. Browsers do not expose this by default; you need a device ID from one of:

- A **companion app** that creates a virtual audio device (loopback) and exposes its ID.
- **System settings** or a tool that lists `getUserMedia` audio devices; use the ID of the loopback device.

In the app, open the **Loopback device ID** field (shown when Rooted Android is selected) and paste or select that device ID. The app will then use `getUserMedia({ audio: { deviceId: { exact: id } } })` to capture from that device.

## Deploy (production VPS)

Production API: **https://translate.lucas-dev-server.tech/functions/v1** (self-hosted Supabase edge functions on VPS).

### Primary: SSH / GitHub Actions → VPS

Edge function source lives in `supabase/functions/`. On the VPS it is bind-mounted into the edge-runtime as `/home/deno/functions` from:

`/root/supabase-translate/volumes/functions`

Manual deploy from a machine with SSH access:

```bash
export TRANSLATE_VPS_HOST=ubuntu@72.61.208.230   # or an SSH config Host alias
export TRANSLATE_VPS_SSH_KEY=~/.ssh/id_ed25519   # optional if default key works
./scripts/deploy-vps.sh
./scripts/verify-vps-deploy.sh
```

Pushing to `main` (when `supabase/functions/**` changes) runs `.github/workflows/deploy-supabase.yml`, which SSHs to the VPS and runs the same deploy. Required GitHub secrets:

- `TRANSLATE_VPS_HOST` — e.g. `ubuntu@72.61.208.230`
- `TRANSLATE_VPS_SSH_KEY` — private key whose public half is in `ubuntu` `authorized_keys`

The workflow also raises Kong `functions-v1` timeouts to **300s** if lower (needed for long segment jobs).

**CORS note:** Browser preflight is handled by **Kong** on the VPS, not only `cors.ts` in edge functions. If a new custom header is blocked (e.g. `x-recent-context`), update Kong — see `scripts/patch-kong-cors-on-vps.sh` — then redeploy functions.

### Not used for production: Supabase Cloud CLI deploy

`supabase functions deploy --project-ref …` targets Supabase Cloud. This app’s production API is the VPS above; Cloud tokens in repo secrets are unused by the VPS workflow.

Backend URL and anon key are defined in `my-interpreter/src/api.ts`; override with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel if needed.

**One-time:** If you still have an old Render service for this app, suspend or delete it in the [Render Dashboard](https://dashboard.render.com/) (Render MCP cannot delete or suspend services).

## Environment

- **Supabase Edge Functions:** Set secrets: `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `VERTEX_AI_REGION` (e.g. us-central1). Service account needs Vertex AI User role for Gemini. Optional: `VERTEX_AI_MODEL` / `GEMINI_DEV_MODEL` (default `gemini-2.5-pro`), `ELEVENLABS_API_KEY`, `ELEVENLABS_STT_MODEL=scribe_v2`. After deploy, ensure the VPS reverse proxy read timeout is ≥ **300s** (segment jobs).
- **Local server (optional):** `server/.env` — see `server/.env.example`. Used only for running the Node backend locally (`cd server && npm start`).
- **my-interpreter:** Backend URL is in `my-interpreter/src/api.ts` (`SUPABASE_PROJECT_URL` / `API_BASE`). Override with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel.

## PWA

Build and preview:

```bash
cd my-interpreter
npm run build
npm run preview
```

Install the app from Chrome/Edge on Windows or Android for offline-capable use. For production, add proper PWA icons (e.g. 192×192 and 512×512 PNG) and update `vite.config.ts` manifest if needed.

## Debugging: capturing console from Chrome (outside Cursor)

To capture console and browser log output so you (or a tool) can inspect errors:

1. **Quit Chrome completely** (all windows), then **start Chrome with remote debugging** (in a normal terminal, outside Cursor). If Chrome was already running, it may say "Opening in existing browser session" and the debug port will not be open.
   - **Linux:** `google-chrome --remote-debugging-port=9222`
   - **macOS:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222`
   - **Windows:** `chrome.exe --remote-debugging-port=9222`

2. In that Chrome window, open your app (e.g. `http://localhost:5174` or your Vercel URL) and reproduce the issue.

3. From the repo root: `cd my-interpreter && npm run capture-console`

4. The script attaches to that Chrome, captures console and Log entries for 30 seconds, and writes them to `my-interpreter/console-output.txt` (and prints to stdout). Share or open that file to inspect errors.
