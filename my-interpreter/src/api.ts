import type { CleanSummarizeResult, InterpretDiagnostics, InterpretResult, RecentContextPair, ResponseResult, TermLockMap } from './types';

/**
 * Supabase Edge Functions base URL.
 * In dev we use a relative path so Vite proxies to Supabase (avoids CORS). In production use full URL.
 */
const SUPABASE_PROJECT_URL = import.meta.env?.VITE_SUPABASE_URL?.replace(/\/+$/, '') || 'https://translate.lucas-dev-server.tech';
const API_BASE = import.meta.env.DEV ? '/functions/v1' : `${SUPABASE_PROJECT_URL}/functions/v1`;

/**
 * Supabase anon key — required by Edge Functions as the `apikey` header.
 * The anon key is safe to be public (it's read-only by design in Supabase).
 * Override with VITE_SUPABASE_ANON_KEY in Vercel env vars if needed.
 */
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'sb_publishable_RZ_ZRT_WlrPdfxuAscHE0w_p96zEzI9';

function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

const FETCH_TIMEOUT_MS = {
  default: 60_000,
  interpret: 90_000,
} as const;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatApiErrorMessage(status: number, raw: string, fallback: string): string {
  let msg = fallback;
  try {
    const err = JSON.parse(raw) as { error?: string };
    if (err?.error) msg = err.error;
  } catch {
    if (raw.trim()) msg = raw.trim();
  }
  if (status === 503 || /VERTEX_AI|GOOGLE_APPLICATION|quota|billing/i.test(msg)) {
    return `AI backend unavailable (${status}): ${msg}`;
  }
  if (status >= 500) {
    return `Server error (${status}): ${msg}`;
  }
  return msg;
}

export function getApiBase(): string {
  return API_BASE;
}

/** GET /functions/v1/health – verify backend is reachable */
export async function healthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/health`,
      { headers: baseHeaders() },
      15_000,
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean };
    return data?.ok ? { ok: true } : { ok: false, error: 'Invalid health response' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /failed to fetch|network|connection closed|ERR_CONNECTION/i.test(msg);
}

/** 503 or quota/rate limit — backend may succeed after a short wait (long meetings). */
function isRetryableInterpretError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /503|429|quota|Quota exceeded|rate limit|free_tier|billing/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doInterpret(
  body: ArrayBuffer,
  headers: Record<string, string>,
): Promise<InterpretResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/interpret`,
    { method: 'POST', headers, body },
    FETCH_TIMEOUT_MS.interpret,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiErrorMessage(res.status, text, `Interpret failed (${res.status})`));
  }
  return res.json() as Promise<InterpretResult>;
}

const INTERPRET_RETRY_DELAYS_MS = [3000, 6000];

export interface InterpretMetricsSample extends InterpretDiagnostics {
  capturedAt: string;
}

const METRICS_STORAGE_KEY = 'interpreter-segment-metrics';

export function appendInterpretMetrics(diagnostics: InterpretDiagnostics): void {
  try {
    const raw = sessionStorage.getItem(METRICS_STORAGE_KEY);
    const existing = raw ? (JSON.parse(raw) as InterpretMetricsSample[]) : [];
    existing.push({ ...diagnostics, capturedAt: new Date().toISOString() });
    sessionStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(existing.slice(-200)));
  } catch {
    // ignore storage failures
  }
}

export function getInterpretMetrics(): InterpretMetricsSample[] {
  try {
    const raw = sessionStorage.getItem(METRICS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as InterpretMetricsSample[]) : [];
  } catch {
    return [];
  }
}

export function clearInterpretMetrics(): void {
  sessionStorage.removeItem(METRICS_STORAGE_KEY);
}

/**
 * Production Kong on the VPS allows x-meeting-context but not yet x-recent-context.
 * Fold recent dialogue into meeting context until Kong is patched (see scripts/patch-kong-cors-on-vps.sh).
 */
function meetingContextWithRecent(
  meetingContext?: string | null,
  recentContext?: RecentContextPair[],
): string | null {
  const base = meetingContext?.trim() ?? '';
  if (!recentContext?.length) return base || null;
  const lines = recentContext.map(
    (p) => `[Burmese]: ${p.burmese.trim()}\n[English]: ${p.english.trim()}`,
  );
  const block = `Recent conversation:\n${lines.join('\n')}`;
  return base ? `${base}\n\n${block}` : block;
}

export async function interpretAudio(
  audioPcm16khz: ArrayBuffer,
  meetingContext?: string | null,
  termLock?: TermLockMap,
  recentContext?: RecentContextPair[],
): Promise<InterpretResult> {
  const headers = baseHeaders({ 'Content-Type': 'application/octet-stream' });
  const meetingPayload = meetingContextWithRecent(meetingContext, recentContext);
  if (meetingPayload) {
    headers['X-Meeting-Context'] = btoa(unescape(encodeURIComponent(meetingPayload)));
  }
  if (termLock && Object.keys(termLock).length > 0) {
    headers['X-Term-Lock'] = btoa(unescape(encodeURIComponent(JSON.stringify(termLock))));
  }
  const body = audioPcm16khz.slice(0);
  const maxAttempts = 1 + INTERPRET_RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(INTERPRET_RETRY_DELAYS_MS[attempt - 1]);
      }
      return await doInterpret(body, headers);
    } catch (e) {
      lastError = e;
      if (isNetworkError(e) && attempt < maxAttempts - 1) {
        continue; // retry without extra delay for network errors
      }
      if (attempt === maxAttempts - 1 || !isRetryableInterpretError(e)) {
        throw e;
      }
    }
  }

  throw lastError;
}

export async function responseTranslate(englishText: string): Promise<ResponseResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/response`,
    {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: englishText }),
    },
    FETCH_TIMEOUT_MS.default,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiErrorMessage(res.status, text, 'Response failed'));
  }
  return res.json() as Promise<ResponseResult>;
}

/** POST /functions/v1/clean-and-summarize – clean transcript using briefing and return summary. */
export async function cleanAndSummarize(
  transcript: string,
  meetingContext?: string | null,
): Promise<CleanSummarizeResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/clean-and-summarize`,
    {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ transcript, meetingContext: meetingContext ?? null }),
    },
    FETCH_TIMEOUT_MS.default,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiErrorMessage(res.status, text, 'Clean & summarize failed'));
  }
  return res.json() as Promise<CleanSummarizeResult>;
}

export interface ResponseAudioResult {
  englishText: string;
  burmeseText: string;
  audioBase64: string | null;
}

export async function responseAudio(pcm16khz: ArrayBuffer): Promise<ResponseAudioResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/response-audio`,
    {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: pcm16khz.slice(0),
    },
    FETCH_TIMEOUT_MS.default,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiErrorMessage(res.status, text, 'Response audio failed'));
  }
  return res.json() as Promise<ResponseAudioResult>;
}
