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
