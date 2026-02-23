# Burmese–English Interpreter PWA

Real-time Burmese-to-English interpreter with three capture modes: **Desktop (Tab Audio)**, **Rooted Android (loopback)**, and **Face-to-Face (mic)**.

## Quick start

### Backend (Node)

```bash
cd server
cp .env.example .env
# Edit .env: set GOOGLE_APPLICATION_CREDENTIALS and GEMINI_API_KEY
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

## Deploy (Render backend)

The backend is deployed as a Web Service on **Render** (root directory: `server`). After changing server code (e.g. fixing the Chirp 3 location), you must **redeploy** so the live API uses the new code:

- **Auto-deploy:** Push to your connected Git branch; Render will build and deploy.
- **Manual:** In the Render dashboard, open the service → **Manual Deploy** → **Deploy latest commit**.

Until you redeploy, the app will keep hitting the old backend and errors like `chirp_3 does not exist in the location named "global"` will continue.

## Environment

- **server/.env**: see `server/.env.example`. Requires Google Cloud credentials (Speech-to-Text, Text-to-Speech) and a Gemini API key.
- **my-interpreter**: optional `VITE_API_URL` to point to the backend (e.g. `https://translate-u6u1.onrender.com`). If unset, dev uses the Vite proxy to `http://localhost:3001`. **Use the digit 1 in the hostname, not the letter L** — `translate-u6ul` will not resolve (ERR_NAME_NOT_RESOLVED).

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
