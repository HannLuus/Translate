import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { transcribeAndTranslateAudio } from '../_shared/gemini.ts';
import { synthesizeSpeech } from '../_shared/tts.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const arrayBuffer = await req.arrayBuffer();
    const audioBytes = new Uint8Array(arrayBuffer);

    if (!audioBytes.length) {
      return new Response(JSON.stringify({ error: 'Request body must be raw audio bytes' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const recentContext = req.headers.get('x-translation-context')?.trim() || null;

    const { burmeseText, englishText } = await transcribeAndTranslateAudio(audioBytes, recentContext);

    if (!englishText) {
      return new Response(
        JSON.stringify({ burmeseText: '', englishText: '', audioBase64: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const audioBase64 = await synthesizeSpeech(englishText, 'en-US');

    return new Response(
      JSON.stringify({ burmeseText, englishText, audioBase64 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Interpret failed';
    console.error('[interpret]', err);

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
