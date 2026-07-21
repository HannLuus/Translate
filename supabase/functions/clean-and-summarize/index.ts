import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { generateMeetingMinutes, type MeetingSegmentInput } from '../_shared/gemini.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    let body: {
      transcript?: unknown;
      meetingContext?: unknown;
      segments?: unknown;
    };
    try {
      body = (await req.json()) as {
        transcript?: unknown;
        meetingContext?: unknown;
        segments?: unknown;
      };
    } catch {
      return new Response(
        JSON.stringify({ error: 'Request body must be valid JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!body || typeof body !== 'object') {
      return new Response(
        JSON.stringify({ error: 'Request body must include { transcript: string } or segments' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const transcript = typeof body.transcript === 'string' ? body.transcript : '';
    const meetingContext = typeof body.meetingContext === 'string' ? body.meetingContext : null;

    let segments: MeetingSegmentInput[] | null = null;
    if (Array.isArray(body.segments)) {
      segments = [];
      for (const item of body.segments) {
        if (!item || typeof item !== 'object') continue;
        const eng = (item as MeetingSegmentInput).english;
        if (typeof eng !== 'string' || !eng.trim()) continue;
        const burmese = (item as MeetingSegmentInput).burmese;
        const segmentIndex = (item as MeetingSegmentInput).segmentIndex;
        segments.push({
          english: eng,
          burmese: typeof burmese === 'string' ? burmese : undefined,
          segmentIndex: typeof segmentIndex === 'number' ? segmentIndex : undefined,
        });
      }
      if (segments.length === 0) segments = null;
    }

    if (!transcript.trim() && !segments?.length) {
      return new Response(
        JSON.stringify({ error: 'Request body must include a non-empty transcript or segments' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const result = await generateMeetingMinutes(transcript, meetingContext, segments);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Meeting minutes failed';
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
