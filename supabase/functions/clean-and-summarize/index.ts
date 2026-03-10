import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { cleanTranscriptAndSummarize } from '../_shared/gemini.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    let body: { transcript?: unknown; meetingContext?: unknown };
    try {
      body = (await req.json()) as { transcript?: unknown; meetingContext?: unknown };
    } catch {
      return new Response(
        JSON.stringify({ error: 'Request body must be valid JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!body || typeof body !== 'object') {
      return new Response(
        JSON.stringify({ error: 'Request body must include { transcript: string }' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    const transcript = typeof body.transcript === 'string' ? body.transcript : null;
    const meetingContext = typeof body.meetingContext === 'string' ? body.meetingContext : null;

    if (!transcript || !transcript.trim()) {
      return new Response(
        JSON.stringify({ error: 'Request body must include a non-empty transcript string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const result = await cleanTranscriptAndSummarize(transcript, meetingContext);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Clean & summarize failed';
    console.error('[clean-and-summarize]', err);
    const isQuotaOrKey =
      /429|quota|Quota exceeded|free_tier|billing|GOOGLE_APPLICATION_CREDENTIALS_JSON|VERTEX_AI_REGION|Vertex AI error/i.test(msg);
    const status = isQuotaOrKey ? 503 : 500;
    const userMessage = isQuotaOrKey
      ? `Vertex AI / config issue. Check Edge Functions → Secrets (VERTEX_AI_API_KEY, VERTEX_AI_REGION, or GOOGLE_APPLICATION_CREDENTIALS_JSON). Details: ${msg}`
      : msg;
    return new Response(JSON.stringify({ error: userMessage }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
