import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.1';
import {
  decodeBase64Url, decryptPayload, DIRECTORY_LIFETIME_MS, envelopeDigest, importSigningKey, isUuid,
  parseEnvelope, readBody, RECEIPT_LIFETIME_MS, signDocument, validateLocation, verifyEnvelope,
  type JsonRecord
} from './protocol.ts';

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS' };
type Device = { device_id: string; profile_id: string; user_id: string | null; dog_id: string | null;
  public_key: string; device_kind: 'dog' | 'participant' };
type Principal = { userId: string | null; dogDeviceId: string | null; token: string };
type Dependencies = { env: (name: string) => string | undefined; fetch?: typeof fetch };

function respond(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers }); }

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function resolveDevice(client: SupabaseClient, id: string): Promise<Device> {
  const { data, error } = await client.rpc('resolve_hunting_relay_device', { p_device_id: id });
  if (error) throw new ApiError(503, 'service_unavailable');
  if (!Array.isArray(data) || data.length !== 1) throw new ApiError(403, 'device_not_authorized');
  return data[0] as Device;
}

async function authenticate(client: SupabaseClient, authorization: string | null): Promise<Principal> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9._-]{1,4096})$/)?.[1];
  if (!token) throw new ApiError(401, 'authentication_required');
  if (/^[0-9a-f]{64}$/i.test(token)) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    const { data, error } = await client.from('hunting_dog_devices').select('id').eq('token_hash', digest).is('revoked_at', null).maybeSingle();
    if (error) throw new ApiError(503, 'service_unavailable');
    if (!data) throw new ApiError(401, 'invalid_device_token');
    return { userId: null, dogDeviceId: data.id as string, token };
  }
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, 'invalid_user_session');
  return { userId: data.user.id, dogDeviceId: null, token };
}

function authorizeDevice(principal: Principal, device: Device) {
  if (!(principal.userId && device.device_kind === 'participant' && device.user_id === principal.userId) &&
    !(principal.dogDeviceId && device.device_kind === 'dog' && device.device_id === principal.dogDeviceId)) {
    throw new ApiError(403, 'device_not_authorized');
  }
}

export async function handleRequest(request: Request, dependencies: Dependencies = { env: name => Deno.env.get(name) }): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
  let body: JsonRecord;
  try { body = await readBody(request); }
  catch (error) { return respond(error instanceof Error && error.message === 'payload_too_large' ? 413 : 400, { error: 'invalid_request_body' }); }
  const action = body.action;
  if (!['capabilities', 'register', 'directory', 'relay', 'receipts', 'revoke', 'set_sharing'].includes(action as string)) {
    return respond(400, { error: 'invalid_action' });
  }
  const env = dependencies.env;
  try {
    const keyId = env('RELAY_ENCRYPTION_KEY_ID');
    const publicKey = env('RELAY_ENCRYPTION_PUBLIC_KEY');
    const encryptionPrivateKey = env('RELAY_ENCRYPTION_PRIVATE_KEY');
    const receiptKeyId = env('RELAY_RECEIPT_KEY_ID');
    const receiptPublicKey = env('RELAY_RECEIPT_PUBLIC_KEY');
    const receiptPrivateKey = env('RELAY_RECEIPT_PRIVATE_KEY');
    if (!keyId || !publicKey || !encryptionPrivateKey || !receiptKeyId || !receiptPublicKey || !receiptPrivateKey) {
      throw new ApiError(503, 'relay_not_configured');
    }
    if (action === 'capabilities') {
      await importSigningKey(receiptPublicKey);
      await crypto.subtle.importKey('spki', decodeBase64Url(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      return respond(200, { protocol: 'location-relay-v1', encryption_key_id: keyId, encryption_public_key: publicKey,
        receipt_key_id: receiptKeyId, receipt_public_key: receiptPublicKey });
    }
    const url = env('SUPABASE_URL');
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    const publishableKey = env('SUPABASE_ANON_KEY');
    if (!url || !serviceKey || !publishableKey) throw new ApiError(503, 'service_unavailable');
    const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: dependencies.fetch } });
    const principal = await authenticate(client, request.headers.get('authorization'));
    const userClient = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${principal.token}` }, fetch: dependencies.fetch } });

    if (action === 'register') {
      if (!principal.userId || !isUuid(body.profile_id) || typeof body.public_key !== 'string') throw new ApiError(403, 'registration_not_allowed');
      try { await importSigningKey(body.public_key); } catch { throw new ApiError(400, 'invalid_public_key'); }
      const { data, error } = await userClient.rpc('register_hunting_relay_device', {
        p_profile_id: body.profile_id, p_public_key: body.public_key
      });
      if (error) throw new ApiError(error.code === '42501' ? 403 : 400, 'registration_rejected');
      if (!isUuid(data)) throw new ApiError(503, 'registration_unavailable');
      return respond(200, { device_id: data });
    }
    if (!isUuid(body.device_id)) throw new ApiError(400, 'invalid_device_id');
    const gateway = await resolveDevice(client, body.device_id);
    authorizeDevice(principal, gateway);
    if (action === 'set_sharing') {
      if (!principal.userId || typeof body.enabled !== 'boolean') throw new ApiError(403, 'sharing_not_allowed');
      const { data, error } = await userClient.rpc('set_hunting_relay_sharing', { p_device_id: gateway.device_id, p_enabled: body.enabled });
      if (error || !isUuid(data)) throw new ApiError(error?.code === '42501' ? 403 : 503, 'sharing_rejected');
      return respond(200, { sharing_epoch: data, enabled: body.enabled });
    }
    if (action === 'revoke') {
      if (!principal.userId) throw new ApiError(403, 'revocation_not_allowed');
      const { error } = await userClient.rpc('revoke_hunting_relay_device', { p_device_id: gateway.device_id });
      if (error) throw new ApiError(503, 'revocation_unavailable');
      return respond(200, { revoked: true });
    }
    const { data: profile, error: profileError } = await client.from('hunting_profiles').select('hunting_mode').eq('id', gateway.profile_id).maybeSingle();
    if (profileError) throw new ApiError(503, 'service_unavailable');
    if (!profile?.hunting_mode) throw new ApiError(409, 'hunting_mode_inactive');
    const now = Date.now();
    if (action === 'directory') {
      const { data, error } = await client.rpc('list_hunting_relay_devices', { p_profile_id: gateway.profile_id });
      if (error) throw new ApiError(503, 'directory_unavailable');
      const devices = [];
      for (const device of data ?? []) {
        try { await importSigningKey(device.public_key); devices.push(device); } catch { continue; }
      }
      return respond(200, await signDocument({ document_type: 'directory', profile_id: gateway.profile_id,
        device_id: gateway.device_id, issued_at: new Date(now).toISOString(), expires_at: new Date(now + DIRECTORY_LIFETIME_MS).toISOString(),
        devices }, receiptKeyId, receiptPrivateKey));
    }
    if (action === 'receipts') {
      const { data, error } = await client.from('hunting_relay_messages')
        .select('origin_device_id,message_id,profile_id,envelope_digest,accepted_at,expires_at,position_applied')
        .eq('profile_id', gateway.profile_id).eq('origin_device_id', gateway.device_id)
        .gt('expires_at', new Date(now - RECEIPT_LIFETIME_MS).toISOString()).order('accepted_at', { ascending: false }).limit(50);
      if (error) throw new ApiError(503, 'receipts_unavailable');
      const receipts = await Promise.all((data ?? []).map(row => signDocument({ document_type: 'receipt',
        profile_id: row.profile_id, origin_device_id: row.origin_device_id, message_id: row.message_id, envelope_digest: row.envelope_digest,
        received_at: row.accepted_at, position_applied: row.position_applied, expires_at: new Date(now + RECEIPT_LIFETIME_MS).toISOString()
      }, receiptKeyId, receiptPrivateKey)));
      return respond(200, { receipts });
    }
    const envelope = parseEnvelope(body.envelope, now);
    let origin: Device;
    try { origin = await resolveDevice(client, envelope.origin_device_id); }
    catch (error) {
      if (error instanceof ApiError && error.status === 403) throw new ApiError(403, 'origin_not_authorized');
      throw error;
    }
    if (origin.profile_id !== gateway.profile_id) throw new ApiError(403, 'relay_not_allowed');
    if (envelope.key_id !== keyId) throw new ApiError(410, 'encryption_key_unavailable');
    if (!await verifyEnvelope(envelope, origin.public_key)) throw new ApiError(403, 'invalid_origin_signature');
    const payload = await decryptPayload(envelope, encryptionPrivateKey);
    const location = validateLocation(payload, origin.device_kind, origin.profile_id, envelope.expires_at, now);
    const digest = await envelopeDigest(envelope);
    const { data, error } = await client.rpc('record_hunting_relay_location', {
      p_gateway_device_id: gateway.device_id, p_origin_device_id: origin.device_id, p_message_id: envelope.message_id,
      p_digest: digest, p_expires_at: envelope.expires_at, p_latitude: location.latitude, p_longitude: location.longitude,
      p_accuracy: location.accuracy, p_recorded_at: location.recorded_at, p_sequence: location.sequence, p_sharing_epoch: location.sharing_epoch
    });
    if (error) throw new ApiError(error.code === '42501' ? 403 : error.code === '22023' ? 400 : 503, 'relay_rejected');
    if (!data?.accepted) throw new ApiError(503, 'acceptance_unconfirmed');
    return respond(200, await signDocument({ document_type: 'receipt', profile_id: origin.profile_id,
      origin_device_id: origin.device_id, message_id: envelope.message_id, envelope_digest: digest,
      received_at: data.received_at, position_applied: data.position_applied,
      expires_at: new Date(now + RECEIPT_LIFETIME_MS).toISOString()
    }, receiptKeyId, receiptPrivateKey));
  } catch (error) {
    if (error instanceof ApiError) return respond(error.status, { error: error.message });
    return respond(400, { error: 'invalid_relay_request' });
  }
}

