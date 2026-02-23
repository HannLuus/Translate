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
    console.error('[response]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Response failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
