import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { translateWithGemini } from '../_shared/gemini.ts';
import { synthesizeSpeech } from '../_shared/tts.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json() as { text?: unknown };
    const text = typeof body?.text === 'string' ? body.text : null;

    if (!text) {
      return new Response(
        JSON.stringify({ error: 'Request body must include { text: string }' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const burmeseText = await translateWithGemini(text, false);
    const audioBase64 = await synthesizeSpeech(burmeseText, 'my-MM');

    return new Response(
      JSON.stringify({ burmeseText, audioBase64 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Response failed';
    console.error('[response]', err);
    const isQuotaOrKey =
      /429|quota|Quota exceeded|free_tier|billing|GOOGLE_APPLICATION_CREDENTIALS_JSON|VERTEX_AI_REGION|Vertex AI error/i.test(msg);
    const status = isQuotaOrKey ? 503 : 500;
    const userMessage = isQuotaOrKey
      ? 'Translation quota or Vertex AI config. Ensure GOOGLE_APPLICATION_CREDENTIALS_JSON and VERTEX_AI_REGION (e.g. us-central1) are set in Edge Functions → Secrets; service account needs Vertex AI User role.'
      : msg;
    return new Response(JSON.stringify({ error: userMessage }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
