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

    const audioBase64 = await synthesizeSpeech(englishText, 'en-US');

    return new Response(
      JSON.stringify({ burmeseText, englishText, audioBase64 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Interpret failed';
    console.error('[interpret]', err);

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
