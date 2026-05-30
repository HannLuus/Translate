import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { transcribeAndTranslateAudio } from '../_shared/gemini.ts';
import { createDiagnostics, logInterpretMetrics } from '../_shared/metrics.ts';
import { synthesizeSpeech } from '../_shared/tts.ts';
import type { TermLockMap } from '../_shared/terminology.ts';

function parseTermLockHeader(raw: string | null): TermLockMap {
  if (!raw?.trim()) return {};
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const lock: TermLockMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && k.trim()) lock[k.toLowerCase()] = v;
    }
    return lock;
  } catch {
    return {};
  }
}

type RecentContextPair = { burmese: string; english: string };

function parseRecentContextHeader(raw: string | null): RecentContextPair[] {
  if (!raw?.trim()) return [];
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded) as unknown;
    if (!Array.isArray(parsed)) return [];
    const pairs: RecentContextPair[] = [];
    for (const item of parsed) {
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
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const startedAt = Date.now();

  try {
    const arrayBuffer = await req.arrayBuffer();
    const audioBytes = new Uint8Array(arrayBuffer);

    if (!audioBytes.length) {
      return new Response(JSON.stringify({ error: 'Request body must be raw audio bytes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const meetingContextRaw = req.headers.get('x-meeting-context');
    let meetingContext: string | null = null;
    if (meetingContextRaw) {
      try {
        meetingContext = decodeURIComponent(meetingContextRaw);
      } catch {
        meetingContext = meetingContextRaw;
      }
    }

    const { burmeseText, englishText, diagnostics: partialDiagnostics, termLock } =
      await transcribeAndTranslateAudio(
        audioBytes,
        meetingContext,
        parseTermLockHeader(req.headers.get('x-term-lock')),
        parseRecentContextHeader(req.headers.get('x-recent-context')),
      );

    const diagnostics = createDiagnostics(startedAt, partialDiagnostics, burmeseText, englishText);
    logInterpretMetrics(diagnostics);

    if (!englishText) {
      return new Response(
        JSON.stringify({ burmeseText: '', englishText: '', audioBase64: null, diagnostics, termLock }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let audioBase64: string | null = null;
    try {
      audioBase64 = await synthesizeSpeech(englishText, 'en-US');
    } catch (ttsErr) {
      console.warn('[interpret] TTS failed, returning translation without audio:', ttsErr);
    }

    return new Response(
      JSON.stringify({ burmeseText, englishText, audioBase64, diagnostics, termLock }),
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
