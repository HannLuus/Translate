import type { CleanSummarizeResult, InterpretResult, ResponseResult } from './types';

/**
 * Supabase Edge Functions base URL.
 * In dev we use a relative path so Vite proxies to Supabase (avoids CORS). In production use full URL.
 */
const SUPABASE_PROJECT_URL = import.meta.env?.VITE_SUPABASE_URL?.replace(/\/+$/, '') || 'https://hbeixuedkdugfrpwpdph.supabase.co';
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

export function getApiBase(): string {
  return API_BASE;
}

/** GET /functions/v1/health – verify backend is reachable */
export async function healthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/health`, { headers: baseHeaders() });
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
  const res = await fetch(`${API_BASE}/interpret`, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Interpret failed (${res.status})`;
    try {
      const err = JSON.parse(text) as { error?: string };
      if (err?.error) msg = err.error;
    } catch {
      if (text.trim()) msg = text.trim();
    }
    throw new Error(msg);
  }
  return res.json() as Promise<InterpretResult>;
}

const INTERPRET_RETRY_DELAYS_MS = [3000, 6000]; // 2 retries (3 attempts total) for 503/rate limit

export async function interpretAudio(
  audioPcm16khz: ArrayBuffer,
  meetingContext?: string | null,
): Promise<InterpretResult> {
  const headers = baseHeaders({ 'Content-Type': 'application/octet-stream' });
  if (meetingContext?.trim()) {
    headers['X-Meeting-Context'] = encodeURIComponent(meetingContext.trim());
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
  const res = await fetch(`${API_BASE}/response`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text: englishText }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Response failed');
  }
  return res.json() as Promise<ResponseResult>;
}

/** POST /functions/v1/clean-and-summarize – clean transcript using briefing and return summary. */
export async function cleanAndSummarize(
  transcript: string,
  meetingContext?: string | null,
): Promise<CleanSummarizeResult> {
  const res = await fetch(`${API_BASE}/clean-and-summarize`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ transcript, meetingContext: meetingContext ?? null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Clean & summarize failed');
  }
  return res.json() as Promise<CleanSummarizeResult>;
}

export interface ResponseAudioResult {
  englishText: string;
  burmeseText: string;
  audioBase64: string | null;
}

export async function responseAudio(pcm16khz: ArrayBuffer): Promise<ResponseAudioResult> {
  const res = await fetch(`${API_BASE}/response-audio`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: pcm16khz.slice(0),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Response audio failed');
  }
  return res.json() as Promise<ResponseAudioResult>;
}
