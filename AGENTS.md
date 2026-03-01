# AGENTS.md

## Cursor Cloud specific instructions

### Architecture

This is a **Burmese-English Interpreter PWA** with two independent npm projects (no monorepo workspace):

| Directory | Role | Dev command | Port |
|---|---|---|---|
| `my-interpreter/` | React 19 + Vite 7 + TypeScript frontend (PWA) | `npm run dev` | 5173 |
| `server/` | Node.js + Express 5 local backend | `npm start` (or `npm run dev` for watch mode) | 3001 |

### Running locally

1. **Backend**: `cd server && npm start` — starts on `http://localhost:3001`. Requires a `.env` file (copy from `.env.example`). API keys are needed for full functionality but the server starts and responds to `/api/health` without them.
2. **Frontend**: `cd my-interpreter && npm run dev` — starts Vite on `http://localhost:5173`. Proxies `/api` to the local backend and `/functions/v1` to the remote Supabase backend.

In dev mode the frontend uses `/functions/v1` (proxied to Supabase Edge Functions) by default. The local backend is used via the `/api` proxy — both are configured in `vite.config.ts`.

### Lint / Build / Test

- **Lint**: `cd my-interpreter && npm run lint` (ESLint; there are a few pre-existing lint errors)
- **Build**: `cd my-interpreter && npm run build` (runs `tsc -b && vite build`)
- **Test**: The server has no automated tests (`npm test` exits with error). No test framework is configured.

### Non-obvious caveats

- The backend requires `GOOGLE_APPLICATION_CREDENTIALS` (GCP service account JSON path) and `GEMINI_API_KEY` in `server/.env` for the interpretation pipeline. Without these, the server starts fine but `/api/interpret`, `/api/response`, and `/api/response-audio` will return errors.
- Audio capture modes (Desktop tab audio, mic) require browser media permissions, which are unavailable in headless/cloud environments. The "Requested device not found" error in the browser is expected in such environments.
- The package manager is **npm** (both projects have `package-lock.json`).
