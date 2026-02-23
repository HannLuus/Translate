/**
 * Converts a Google service account JSON (as a string) into a short-lived
 * OAuth2 access token using the JWT Bearer flow.
 *
 * Works in Deno / Supabase Edge Functions with no Node.js dependencies.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

// Cache token for up to 55 minutes (Google tokens last 60 min).
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export function getProjectId(): string {
  const json = Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS_JSON');
  if (!json) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
  const sa: ServiceAccount = JSON.parse(json);
  return sa.project_id;
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const json = Deno.env.get('GOOGLE_APPLICATION_CREDENTIALS_JSON');
  if (!json) throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
  const sa: ServiceAccount = JSON.parse(json);

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Import the RSA private key
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const encoder = new TextEncoder();
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(signingInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${signingInput}.${sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Failed to get Google access token: ${err}`);
  }

  const data = await tokenRes.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}
