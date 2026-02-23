import type { InterpretResult, ResponseResult } from './types';

/** Canonical backend URL from Render (verify via Render MCP: list_services → serviceDetails.url). Single source of truth. */
const RENDER_BACKEND_URL = 'https://translate-u6u1.onrender.com';

const API_BASE = (() => {
  const url = typeof import.meta.env?.VITE_API_URL === 'string' ? import.meta.env.VITE_API_URL : '';
  const base = url ? url.replace(/\/+$/, '') : '';
  if (!base) return RENDER_BACKEND_URL;
  // Fix common typos (ugul/ubul/u6ul) so they resolve to the canonical Render URL.
  if (/translate-(ugul|ubul|u6ul)\.onrender\.com/.test(base)) return RENDER_BACKEND_URL;
  return base;
})();

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

export async function interpretAudio(audioPcm16khz: ArrayBuffer): Promise<InterpretResult> {
  const url = `${API_BASE}/api/interpret`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
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
