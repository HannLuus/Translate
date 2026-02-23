import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { transcribeBurmese } from '../_shared/speech.ts';
import { translateWithGemini } from '../_shared/gemini.ts';
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

    const previousSentence = req.headers.get('x-translation-context')?.trim() || null;

    const burmeseText = await transcribeBurmese(audioBytes);
    if (!burmeseText) {
      return new Response(
        JSON.stringify({ burmeseText: '', englishText: '', audioBase64: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const englishText = await translateWithGemini(burmeseText, true, previousSentence);
    const audioBase64 = await synthesizeSpeech(englishText, 'en-US');

    return new Response(
      JSON.stringify({ burmeseText, englishText, audioBase64 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[interpret]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Interpret failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
