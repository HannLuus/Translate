import type { InterpretResult, ResponseResult } from './types';

/**
 * Supabase Edge Functions base URL.
 * Set VITE_SUPABASE_URL in Vercel env vars (the Project URL from the Supabase dashboard,
 * e.g. https://abcdefghijklmno.supabase.co). Falls back to the value below.
 */
const SUPABASE_PROJECT_URL = import.meta.env?.VITE_SUPABASE_URL?.replace(/\/+$/, '') || 'https://hbeixuedkdugfrpwpdph.supabase.co';
const API_BASE = `${SUPABASE_PROJECT_URL}/functions/v1`;

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

export async function interpretAudio(
  audioPcm16khz: ArrayBuffer,
  previousEnglishSentence?: string | null,
): Promise<InterpretResult> {
  const headers = baseHeaders({ 'Content-Type': 'application/octet-stream' });
  if (previousEnglishSentence?.trim()) {
    headers['X-Translation-Context'] = previousEnglishSentence.trim();
  }
  const res = await fetch(`${API_BASE}/interpret`, {
    method: 'POST',
    headers,
    body: audioPcm16khz,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Interpret failed');
  }
  return res.json() as Promise<InterpretResult>;
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

export interface ResponseAudioResult {
  englishText: string;
  burmeseText: string;
  audioBase64: string | null;
}

export async function responseAudio(pcm16khz: ArrayBuffer): Promise<ResponseAudioResult> {
  const res = await fetch(`${API_BASE}/response-audio`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/octet-stream' }),
    body: pcm16khz,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Response audio failed');
  }
  return res.json() as Promise<ResponseAudioResult>;
}
