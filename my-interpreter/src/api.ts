import type { InterpretResult, ResponseResult } from './types';

const API_BASE =
  typeof import.meta.env?.VITE_API_URL === 'string'
    ? import.meta.env.VITE_API_URL
    : '';

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
