import type {
  CleanSummarizeResult,
  InterpretDiagnostics,
  InterpretResult,
  MeetingMinutesResult,
  RecentContextPair,
  ResponseResult,
  TermLockMap,
} from './types';

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
  /** ~3 min audio + Pro MT */
  interpretSegment: 180_000,
  meetingMinutes: 180_000,
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

/** Transient failures worth retrying on long meetings. */
function isRetryableInterpretError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /503|502|504|429|quota|Quota exceeded|rate limit|free_tier|billing|timed out|timeout|Gateway/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

const INTERPRET_RETRY_DELAYS_MS = [3000, 6000, 12000];

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

/** Cap glossary/briefing size so request bodies stay reasonable. */
function capMeetingContext(meetingContext?: string | null, maxChars = 12_000): string | null {
  const base = meetingContext?.trim() ?? '';
  if (!base) return null;
  if (base.length <= maxChars) return base;
  return base.slice(0, maxChars) + '\n\n[Meeting context truncated for size.]';
}

function capTermLock(termLock?: TermLockMap, maxEntries = 80): TermLockMap | undefined {
  if (!termLock) return undefined;
  const entries = Object.entries(termLock);
  if (entries.length === 0) return undefined;
  if (entries.length <= maxEntries) return termLock;
  return Object.fromEntries(entries.slice(-maxEntries));
}

/**
 * Batch interpret: ~3-minute PCM segment with context in JSON body (avoids header bloat / Kong CORS).
 */
export async function interpretSegment(
  audioPcm16khz: ArrayBuffer,
  meetingContext?: string | null,
  termLock?: TermLockMap,
  recentContext?: RecentContextPair[],
): Promise<InterpretResult> {
  const body = JSON.stringify({
    audioBase64: arrayBufferToBase64(audioPcm16khz),
    sampleRate: 16000,
    meetingContext: capMeetingContext(meetingContext),
    termLock: capTermLock(termLock) ?? {},
    recentContext: (recentContext ?? []).slice(-4),
    mode: 'segment',
  });

  const headers = baseHeaders({ 'Content-Type': 'application/json' });
  const maxAttempts = 1 + INTERPRET_RETRY_DELAYS_MS.length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        await delay(INTERPRET_RETRY_DELAYS_MS[attempt - 1]);
      }
      const res = await fetchWithTimeout(
        `${API_BASE}/interpret`,
        { method: 'POST', headers, body },
        FETCH_TIMEOUT_MS.interpretSegment,
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(formatApiErrorMessage(res.status, text, `Interpret failed (${res.status})`));
      }
      return res.json() as Promise<InterpretResult>;
    } catch (e) {
      lastError = e;
      if (isNetworkError(e) && attempt < maxAttempts - 1) {
        continue;
      }
      if (attempt === maxAttempts - 1 || !isRetryableInterpretError(e)) {
        throw e;
      }
    }
  }

  throw lastError;
}

/** @deprecated Prefer interpretSegment for meetings. */
export async function interpretAudio(
  audioPcm16khz: ArrayBuffer,
  meetingContext?: string | null,
  termLock?: TermLockMap,
  recentContext?: RecentContextPair[],
): Promise<InterpretResult> {
  return interpretSegment(audioPcm16khz, meetingContext, termLock, recentContext);
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

export interface TranscriptSegmentInput {
  burmese?: string;
  english: string;
  segmentIndex?: number;
}

/** POST /functions/v1/clean-and-summarize – structured meeting minutes from bilingual transcript. */
export async function generateMeetingMinutes(
  transcript: string,
  meetingContext?: string | null,
  segments?: TranscriptSegmentInput[],
): Promise<MeetingMinutesResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/clean-and-summarize`,
    {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        transcript,
        meetingContext: meetingContext ?? null,
        segments: segments ?? null,
      }),
    },
    FETCH_TIMEOUT_MS.meetingMinutes,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiErrorMessage(res.status, text, 'Meeting minutes failed'));
  }
  const data = (await res.json()) as MeetingMinutesResult;
  return normalizeMinutes(data);
}

/** @deprecated Use generateMeetingMinutes */
export async function cleanAndSummarize(
  transcript: string,
  meetingContext?: string | null,
): Promise<CleanSummarizeResult> {
  return generateMeetingMinutes(transcript, meetingContext);
}

function normalizeMinutes(data: Partial<MeetingMinutesResult>): MeetingMinutesResult {
  const chronologicalRecord =
    (data.chronologicalRecord ?? data.cleanedTranscript ?? '').trim();
  const executiveSummary = (data.executiveSummary ?? data.summary ?? '').trim();
  const decisions = Array.isArray(data.decisions) ? data.decisions.map(String) : [];
  const actionItems = Array.isArray(data.actionItems) ? data.actionItems.map(String) : [];
  const openQuestions = Array.isArray(data.openQuestions) ? data.openQuestions.map(String) : [];
  const keyPoints = Array.isArray(data.keyPoints)
    ? data.keyPoints.map(String)
    : [...decisions, ...actionItems].slice(0, 8);

  return {
    executiveSummary,
    chronologicalRecord,
    decisions,
    actionItems,
    openQuestions,
    cleanedTranscript: chronologicalRecord,
    summary: executiveSummary,
    keyPoints,
  };
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
