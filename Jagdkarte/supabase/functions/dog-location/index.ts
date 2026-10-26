import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8'
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
  if (Number(request.headers.get('content-length')) > 4096) return respond(413, { error: 'payload_too_large' });

  const token = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
  if (!token) return respond(401, { error: 'invalid_device_token' });

  let payload: Record<string, unknown>;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 4096) return respond(413, { error: 'payload_too_large' });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return respond(400, { error: 'invalid_payload' });
    }
    payload = value as Record<string, unknown>;
  } catch {
    return respond(400, { error: 'invalid_json' });
  }

  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracy = payload.accuracy;
  const recordedAt = typeof payload.recorded_at === 'string' ? Date.parse(payload.recorded_at) : NaN;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) ||
    latitude < -90 || latitude > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) ||
    longitude < -180 || longitude > 180 || typeof accuracy !== 'number' || !Number.isFinite(accuracy) ||
    accuracy < 0 || accuracy > 5000 || !Number.isFinite(recordedAt) ||
    recordedAt > Date.now() + 5 * 60 * 1000) {
    return respond(400, { error: 'invalid_location' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return respond(503, { error: 'service_unavailable' });

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: device, error: deviceError } = await client.from('hunting_dog_devices')
    .select('id').eq('token_hash', tokenHash).is('revoked_at', null).maybeSingle();
  if (deviceError) return respond(503, { error: 'service_unavailable' });
  if (!device) return respond(401, { error: 'invalid_device_token' });

  const { data: accepted, error: locationError } = await client.rpc('record_hunting_dog_location', {
    p_device_id: device.id,
    p_latitude: latitude,
    p_longitude: longitude,
    p_accuracy: accuracy,
    p_recorded_at: new Date(recordedAt).toISOString()
  });
  if (locationError) {
    if (locationError.message.includes('Jagdmodus')) return respond(409, { error: 'hunting_mode_inactive' });
    if (locationError.message.includes('Ungueltige Positionsdaten')) return respond(400, { error: 'invalid_location' });
    return respond(503, { error: 'service_unavailable' });
  }
  return respond(200, { accepted: Boolean(accepted), received_at: new Date().toISOString() });
});