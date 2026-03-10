# Burmese–English Interpreter PWA

Real-time Burmese-to-English interpreter with three capture modes: **Desktop (Tab Audio)**, **Rooted Android (loopback)**, and **Face-to-Face (mic)**.

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

## Deploy (Supabase backend)

The backend runs as **Supabase Edge Functions** (see `supabase/functions/`). Pushing to `main` triggers a GitHub Action that runs `supabase functions deploy`, so the live API updates within seconds.

- **Auto-deploy:** Push to `main`; the workflow `.github/workflows/deploy-supabase.yml` deploys all Edge Functions.
- **Manual:** From the repo root run `supabase functions deploy --project-ref hbeixuedkdugfrpwpdph --no-verify-jwt`.

Backend URL and anon key are defined in `my-interpreter/src/api.ts`; override with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel if needed.

**One-time:** If you still have an old Render service for this app, suspend or delete it in the [Render Dashboard](https://dashboard.render.com/) (Render MCP cannot delete or suspend services).

## Environment

- **Supabase Edge Functions:** Set secrets: `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `VERTEX_AI_REGION` (e.g. us-central1). Service account needs Vertex AI User role for Gemini.
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
