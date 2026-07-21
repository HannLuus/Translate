import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { transcribeAndTranslateAudio } from '../_shared/gemini.ts';
import { createDiagnostics, logInterpretMetrics } from '../_shared/metrics.ts';
import { synthesizeSpeech } from '../_shared/tts.ts';
import type { TermLockMap } from '../_shared/terminology.ts';

function decodeBase64Header(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

function parseTermLock(raw: unknown): TermLockMap {
  if (!raw || typeof raw !== 'object') return {};
  const lock: TermLockMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && k.trim()) lock[k.toLowerCase()] = v;
  }
  return lock;
}

function parseTermLockHeader(raw: string | null): TermLockMap {
  const decoded = decodeBase64Header(raw);
  if (!decoded) return {};
  try {
    return parseTermLock(JSON.parse(decoded));
  } catch {
    return {};
  }
}

type RecentContextPair = { burmese: string; english: string };

function parseRecentContext(raw: unknown): RecentContextPair[] {
  if (!Array.isArray(raw)) return [];
  const pairs: RecentContextPair[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as RecentContextPair).burmese === 'string' &&
      typeof (item as RecentContextPair).english === 'string'
    ) {
      pairs.push({
        burmese: (item as RecentContextPair).burmese,
        english: (item as RecentContextPair).english,
      });
    }
  }
  return pairs;
}

function parseRecentContextHeader(raw: string | null): RecentContextPair[] {
  const decoded = decodeBase64Header(raw);
  if (!decoded) return [];
  try {
    return parseRecentContext(JSON.parse(decoded));
  } catch {
    return [];
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const startedAt = Date.now();

  try {
    const contentType = req.headers.get('content-type') ?? '';
    let audioBytes: Uint8Array;
    let meetingContext: string | null = null;
    let termLock: TermLockMap = {};
    let recentContext: RecentContextPair[] = [];

    if (contentType.includes('application/json')) {
      const body = await req.json() as {
        audioBase64?: string;
        meetingContext?: string | null;
        termLock?: unknown;
        recentContext?: unknown;
        mode?: string;
      };
      if (!body?.audioBase64 || typeof body.audioBase64 !== 'string') {
        return new Response(
          JSON.stringify({ error: 'JSON body must include audioBase64 (PCM 16 kHz mono)' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      audioBytes = base64ToBytes(body.audioBase64);
      meetingContext = typeof body.meetingContext === 'string' ? body.meetingContext : null;
      termLock = parseTermLock(body.termLock);
      recentContext = parseRecentContext(body.recentContext);
    } else {
      const arrayBuffer = await req.arrayBuffer();
      audioBytes = new Uint8Array(arrayBuffer);
      meetingContext = decodeBase64Header(req.headers.get('x-meeting-context'));
      termLock = parseTermLockHeader(req.headers.get('x-term-lock'));
      recentContext = parseRecentContextHeader(req.headers.get('x-recent-context'));
    }

    if (!audioBytes.length) {
      return new Response(
        JSON.stringify({ burmeseText: '', englishText: '', audioBase64: null, diagnostics: null, termLock: {} }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { burmeseText, englishText, diagnostics: partialDiagnostics, termLock: updatedLock } =
      await transcribeAndTranslateAudio(
        audioBytes,
        meetingContext,
        termLock,
        recentContext,
      );

    const diagnostics = createDiagnostics(startedAt, partialDiagnostics, burmeseText, englishText);
    logInterpretMetrics(diagnostics);

    if (!englishText && !burmeseText) {
      return new Response(
        JSON.stringify({
          burmeseText: '',
          englishText: '',
          audioBase64: null,
          diagnostics,
          termLock: updatedLock,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let audioBase64: string | null = null;
    if (englishText) {
      try {
        audioBase64 = await synthesizeSpeech(englishText, 'en-US');
      } catch (ttsErr) {
        console.warn('[interpret] TTS failed, returning translation without audio:', ttsErr);
      }
    }

    return new Response(
      JSON.stringify({
        burmeseText,
        englishText,
        audioBase64,
        diagnostics,
        termLock: updatedLock,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Interpret failed';
    console.error('[interpret]', err);

    const isQuotaOrKey =
      /429|quota|Quota exceeded|free_tier|billing|GOOGLE_APPLICATION_CREDENTIALS_JSON|VERTEX_AI_REGION|VERTEX_AI_API_KEY|VERTEX_AI_PROJECT_ID|Vertex AI error|TTS error/i.test(msg);
    const status = isQuotaOrKey ? 503 : 500;
    const userMessage = isQuotaOrKey
      ? `Vertex AI / config issue. Check Edge Functions → Secrets (VERTEX_AI_API_KEY, VERTEX_AI_PROJECT_ID, VERTEX_AI_REGION, or GOOGLE_APPLICATION_CREDENTIALS_JSON for TTS). Details: ${msg}`
      : msg;

    return new Response(JSON.stringify({ error: userMessage }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
