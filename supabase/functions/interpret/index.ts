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

    const meetingContextRaw = req.headers.get('x-meeting-context');
    let meetingContext: string | null = null;
    if (meetingContextRaw) {
      try {
        meetingContext = decodeURIComponent(meetingContextRaw);
      } catch {
        meetingContext = meetingContextRaw;
      }
    }

    const { burmeseText, englishText } = await transcribeAndTranslateAudio(audioBytes, meetingContext);

    if (!englishText) {
      return new Response(
        JSON.stringify({ burmeseText: '', englishText: '', audioBase64: null }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let audioBase64: string | null = null;
    try {
      audioBase64 = await synthesizeSpeech(englishText, 'en-US');
    } catch (ttsErr) {
      console.warn('[interpret] TTS failed, returning translation without audio:', ttsErr);
      // Still return translation; client can show text without playback
    }

    return new Response(
      JSON.stringify({ burmeseText, englishText, audioBase64 }),
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
