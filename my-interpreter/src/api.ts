import type { InterpretResult, ResponseResult } from './types';

/**
 * Canonical backend URL. Single source of truth — verify via Render MCP list_services → serviceDetails.url.
 * The app must never use a typo (u6ul, ugul, ubul). All requests go through getApiBase() which enforces this.
 */
const RENDER_BACKEND_URL = 'https://translate-u6u1.onrender.com';

function normalizeBaseFromEnv(): string {
  const raw = typeof import.meta.env?.VITE_API_URL === 'string' ? import.meta.env.VITE_API_URL.trim() : '';
  const base = raw ? raw.replace(/\/+$/, '').trim() : '';
  if (!base) return RENDER_BACKEND_URL;
  try {
    const u = new URL(base);
    const host = u.hostname.toLowerCase();
    if (host.includes('translate') && host.includes('onrender.com')) return RENDER_BACKEND_URL;
    return base;
  } catch {
    return RENDER_BACKEND_URL;
  }
}

const API_BASE = normalizeBaseFromEnv();

if (typeof window !== 'undefined' && API_BASE.includes('onrender.com') && !API_BASE.startsWith('https://translate-u6u1.onrender.com')) {
  console.error('[Translate] Invalid backend URL (typo?). Using canonical:', RENDER_BACKEND_URL);
}

export function getApiBase(): string {
  return API_BASE;
}

/** GET /api/health – use on app load to verify backend is reachable */
export async function healthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean };
    return data?.ok ? { ok: true } : { ok: false, error: 'Invalid health response' };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function interpretAudio(
  audioPcm16khz: ArrayBuffer,
  previousEnglishSentence?: string | null
): Promise<InterpretResult> {
  const url = `${API_BASE}/api/interpret`;
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (previousEnglishSentence && previousEnglishSentence.trim()) {
    headers['X-Translation-Context'] = previousEnglishSentence.trim();
  }
  const res = await fetch(url, {
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
  const url = `${API_BASE}/api/response`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const url = `${API_BASE}/api/response-audio`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm16khz,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Response audio failed');
  }
  return res.json() as Promise<ResponseAudioResult>;
}
