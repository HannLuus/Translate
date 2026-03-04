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
      /429|quota|Quota exceeded|free_tier|billing|GEMINI_API_KEY is not set/i.test(msg);
    const status = isQuotaOrKey ? 503 : 500;
    const userMessage = isQuotaOrKey
      ? 'Translation quota or API key issue. Set GEMINI_API_KEY in Supabase (Edge Functions → Secrets) to a key with billing enabled: https://aistudio.google.com/apikey'
      : msg;
    return new Response(JSON.stringify({ error: userMessage }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
