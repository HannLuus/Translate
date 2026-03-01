# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Burmese–English Interpreter PWA with two main packages:

| Component | Path | Purpose |
|---|---|---|
| Frontend | `my-interpreter/` | React + TypeScript + Vite PWA (port 5173) |
| Local backend | `server/` | Express.js Node server (port 3001, optional for dev) |
| Edge Functions | `supabase/functions/` | Deno-based Supabase Edge Functions (production backend) |

### Running the frontend dev server

```bash
cd my-interpreter && npm run dev
```

The Vite dev server proxies `/functions/v1` to the remote Supabase backend (`hbeixuedkdugfrpwpdph.supabase.co`), so **no local backend is needed** for the UI to connect to the API. The status indicator at the top of the page should say "Backend connected" in green.

### Lint and build

- **Lint:** `cd my-interpreter && npm run lint` (ESLint; pre-existing warnings/errors exist in the codebase)
- **Build:** `cd my-interpreter && npm run build` (runs `tsc -b && vite build`)
- **No automated tests:** The `server/` package has `"test": "echo \"Error: no test specified\" && exit 1"` and the frontend has no test script.

### Local Node backend (optional)

Only needed if the remote Supabase backend is unavailable. Requires `GOOGLE_APPLICATION_CREDENTIALS` and `GEMINI_API_KEY` in `server/.env` (see `server/.env.example`).

```bash
cd server && npm start
```

### Gotchas

- The frontend uses `package-lock.json` (npm). The server also uses npm.
- There is no database; Supabase is used only for Edge Functions.
- Audio capture modes (Desktop Tab Audio, Rooted Android loopback) require browser-specific APIs that are only available in real browsers with audio hardware — the Face-to-Face (mic) mode is the simplest to test.
- The `vite.config.ts` proxy sends `/api` to `localhost:3001` and `/functions/v1` to the remote Supabase project. In dev mode, `api.ts` uses the relative `/functions/v1` path (proxied).
