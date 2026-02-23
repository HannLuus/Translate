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

## Environment

- **server/.env**: see `server/.env.example`. Requires Google Cloud credentials (Speech-to-Text, Text-to-Speech) and a Gemini API key.
- **my-interpreter**: optional `VITE_API_URL` to point to the backend (e.g. in production). If unset, dev uses the Vite proxy to `http://localhost:3001`.

## PWA

Build and preview:

```bash
cd my-interpreter
npm run build
npm run preview
```

Install the app from Chrome/Edge on Windows or Android for offline-capable use. For production, add proper PWA icons (e.g. 192×192 and 512×512 PNG) and update `vite.config.ts` manifest if needed.
