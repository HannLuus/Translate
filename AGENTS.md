## Cursor Cloud specific instructions

### Overview

This is a **Burmese–English Interpreter PWA** with two independent services:

| Service | Directory | Run command | Port |
|---|---|---|---|
| Frontend (Vite + React) | `my-interpreter/` | `npm run dev` | 5173 |
| Backend (Express) | `server/` | `npm start` | 3001 |

Standard dev commands (`dev`, `build`, `lint`, `start`) are in each `package.json`. See the root `README.md` for full details.

### Non-obvious caveats

- **Backend needs API keys to do real work.** The Express server starts without credentials, but API endpoints (`/api/interpret`, `/api/response`, `/api/response-audio`) will fail at runtime without `GEMINI_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS` (or `GOOGLE_APPLICATION_CREDENTIALS_JSON`) in `server/.env`. The `/api/health` endpoint works without credentials.
- **Frontend works without a local backend.** The Vite config proxies both `/api` (local Express on port 3001) and `/functions/v1` (remote Supabase). The React app defaults to the remote Supabase Edge Functions backend, so the frontend is functional for UI development even without running the local server.
- **Lint has pre-existing warnings/errors.** Running `npm run lint` in `my-interpreter/` reports 2 errors and 1 warning in existing code — these are not caused by environment issues.
- **No database or Docker required.** The app is entirely stateless; there are no migrations or containerized services.
- **`server/.env` must be created from `server/.env.example`** before the backend can load environment variables. The dotenv package reads this file on startup.
