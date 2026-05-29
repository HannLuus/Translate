export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, x-client-id, apikey, content-type, accept, ' +
    'x-supabase-api-version, x-translation-context, x-meeting-context, x-term-lock',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}
