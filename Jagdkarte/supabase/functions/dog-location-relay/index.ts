import { createClient } from 'npm:@supabase/supabase-js@2';

const MAX_BODY_BYTES = 8192;
const MAX_LOCATION_BYTES = 4096;
const MAX_RELAY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RELAY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SIGNING_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const ENCRYPTION_ALGORITHM = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8'
};

type JsonRecord = Record<string, unknown>;
type Device = {
  id: string;
  dog_id: string;
  relay_signing_public_key?: string | null;
};

function respond(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  try {
    const base64 = unpadded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function importSigningKey(encodedKey: string): Promise<CryptoKey | null> {
  const keyBytes = decodeBase64Url(encodedKey);
  if (!keyBytes) return null;
  try {
    const key = await crypto.subtle.importKey('spki', keyBytes, SIGNING_ALGORITHM, false, ['verify']);
    const modulusLength = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    return modulusLength >= 2048 && modulusLength <= 4096 ? key : null;
  } catch {
    return null;
  }
}

async function importEncryptionPublicKey(encodedKey: string): Promise<CryptoKey | null> {
  const keyBytes = decodeBase64Url(encodedKey);
  if (!keyBytes) return null;
  try {
    const key = await crypto.subtle.importKey('spki', keyBytes, ENCRYPTION_ALGORITHM, false, ['encrypt']);
    const modulusLength = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    return modulusLength >= 2048 && modulusLength <= 4096 ? key : null;
  } catch {
    return null;
  }
}

async function getDeviceByToken(client: ReturnType<typeof createClient>, token: string) {
  return client.from('hunting_dog_devices')
    .select('id, dog_id')
    .eq('token_hash', await tokenHash(token))
    .is('revoked_at', null)
    .maybeSingle();
}

function isValidLocation(payload: JsonRecord, now: number): boolean {
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracy = payload.accuracy;
  const recordedAt = typeof payload.recorded_at === 'string' ? Date.parse(payload.recorded_at) : NaN;
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 &&
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 5000 &&
    Number.isFinite(recordedAt) && recordedAt <= now + FUTURE_CLOCK_SKEW_MS &&
    now - recordedAt <= MAX_RELAY_AGE_MS;
}

function signingInput(
  originDeviceId: string,
  messageId: string,
  expiresAt: string,
  keyId: string,
  encryptedKey: string,
  nonce: string,
  ciphertext: string
): Uint8Array {
  const canonical = [
    'dog-location-relay-v1',
    originDeviceId.toLowerCase(),
    messageId.toLowerCase(),
    expiresAt,
    keyId,
    encryptedKey,
    nonce,
    ciphertext
  ].join('\n');
  return new TextEncoder().encode(canonical);
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return respond(413, { error: 'payload_too_large' });
  }

  let body: unknown;
  try {
    const bytes = await readBoundedBody(request);
    if (!bytes) return respond(413, { error: 'payload_too_large' });
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return respond(400, { error: 'invalid_json' });
  }
  if (!isRecord(body)) return respond(400, { error: 'invalid_payload' });

  const action = body.action;
  if (action !== 'get_server_key' && action !== 'register_key' && action !== 'relay') {
    return respond(400, { error: 'invalid_action' });
  }

  const encryptionKeyId = Deno.env.get('RELAY_ENCRYPTION_KEY_ID');
  const encryptionPublicKey = Deno.env.get('RELAY_ENCRYPTION_PUBLIC_KEY');
  if (action === 'get_server_key') {
    if (!encryptionKeyId || !/^[A-Za-z0-9._-]{1,64}$/.test(encryptionKeyId) || !encryptionPublicKey ||
      !(await importEncryptionPublicKey(encryptionPublicKey))) {
      return respond(503, { error: 'service_unavailable' });
    }
    return respond(200, { key_id: encryptionKeyId, public_key: encryptionPublicKey });
  }

  const token = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
  if (!token) return respond(401, { error: 'invalid_device_token' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return respond(503, { error: 'service_unavailable' });

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: relayDeviceData, error: relayDeviceError } = await getDeviceByToken(client, token);
  if (relayDeviceError) return respond(503, { error: 'service_unavailable' });
  if (!relayDeviceData) return respond(401, { error: 'invalid_device_token' });
  const relayDevice = relayDeviceData as Device;

  if (action === 'register_key') {
    if (typeof body.public_key !== 'string' || body.public_key.length > 2048 ||
      !(await importSigningKey(body.public_key))) {
      return respond(400, { error: 'invalid_public_key' });
    }
    const { data, error } = await client.from('hunting_dog_devices')
      .update({ relay_signing_public_key: body.public_key })
      .eq('id', relayDevice.id)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();
    if (error) return respond(503, { error: 'service_unavailable' });
    if (!data) return respond(401, { error: 'invalid_device_token' });
    return respond(200, { registered: true, device_id: relayDevice.id });
  }

  const originDeviceId = body.origin_device_id;
  const messageId = body.message_id;
  const expiresAtValue = body.expires_at;
  const keyId = body.key_id;
  const encryptedKeyValue = body.encrypted_key;
  const nonceValue = body.nonce;
  const ciphertextValue = body.ciphertext;
  const signatureValue = body.signature;
  if (!isUuid(originDeviceId) || !isUuid(messageId) || typeof expiresAtValue !== 'string' ||
    typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
    typeof encryptedKeyValue !== 'string' || typeof nonceValue !== 'string' ||
    typeof ciphertextValue !== 'string' || typeof signatureValue !== 'string') {
    return respond(400, { error: 'invalid_relay_message' });
  }

  const expiresAt = Date.parse(expiresAtValue);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expiresAtValue ||
    expiresAt <= now || expiresAt > now + MAX_RELAY_LIFETIME_MS) {
    return respond(410, { error: 'message_expired' });
  }

  const { data: originDeviceData, error: originDeviceError } = await client.from('hunting_dog_devices')
    .select('id, dog_id, relay_signing_public_key')
    .eq('id', originDeviceId)
    .is('revoked_at', null)
    .maybeSingle();
  if (originDeviceError) return respond(503, { error: 'service_unavailable' });
  if (!originDeviceData?.relay_signing_public_key) return respond(403, { error: 'origin_not_relayable' });
  const originDevice = originDeviceData as Device;
  if (originDevice.id === relayDevice.id) return respond(400, { error: 'direct_upload_required' });

  const dogIds = [...new Set([relayDevice.dog_id, originDevice.dog_id])];
  const { data: dogs, error: dogsError } = await client.from('hunting_dogs')
    .select('id, profile_id')
    .in('id', dogIds);
  if (dogsError) return respond(503, { error: 'service_unavailable' });
  const profileByDog = new Map((dogs ?? []).map(dog => [dog.id, dog.profile_id]));
  const relayProfileId = profileByDog.get(relayDevice.dog_id);
  const originProfileId = profileByDog.get(originDevice.dog_id);
  if (!relayProfileId || relayProfileId !== originProfileId) {
    return respond(403, { error: 'relay_not_allowed' });
  }

  if (!encryptionKeyId || keyId !== encryptionKeyId || !encryptionPublicKey) {
    return respond(410, { error: 'encryption_key_unavailable' });
  }
  const encryptedKey = decodeBase64Url(encryptedKeyValue);
  const nonce = decodeBase64Url(nonceValue);
  const ciphertext = decodeBase64Url(ciphertextValue);
  const signature = decodeBase64Url(signatureValue);
  const signingKey = await importSigningKey(originDevice.relay_signing_public_key);
  if (!encryptedKey || encryptedKey.byteLength > 1024 || !nonce || nonce.byteLength !== 12 || !ciphertext ||
    ciphertext.byteLength < 17 || ciphertext.byteLength > MAX_LOCATION_BYTES + 16 ||
    !signature || !signingKey || signature.byteLength !== (signingKey.algorithm as RsaHashedKeyAlgorithm).modulusLength / 8) {
    return respond(400, { error: 'invalid_relay_message' });
  }

  const validSignature = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKey,
    signature,
    signingInput(
      originDevice.id,
      messageId,
      expiresAtValue,
      keyId,
      encryptedKeyValue,
      nonceValue,
      ciphertextValue
    )
  ).catch(() => false);
  if (!validSignature) return respond(401, { error: 'invalid_origin_signature' });

  const privateKeyValue = Deno.env.get('RELAY_ENCRYPTION_PRIVATE_KEY');
  const privateKeyBytes = decodeBase64Url(privateKeyValue);
  if (!privateKeyBytes) return respond(503, { error: 'service_unavailable' });

  let location: JsonRecord;
  let recordedAt: number;
  try {
    const decryptionKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      ENCRYPTION_ALGORITHM,
      false,
      ['decrypt']
    );
    const rawAesKey = await crypto.subtle.decrypt(ENCRYPTION_ALGORITHM, decryptionKey, encryptedKey);
    if (rawAesKey.byteLength !== 32) return respond(400, { error: 'invalid_encrypted_payload' });
    const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      aesKey,
      ciphertext
    );
    if (plaintext.byteLength > MAX_LOCATION_BYTES) return respond(413, { error: 'payload_too_large' });

    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!isRecord(payload) || !isValidLocation(payload, now)) {
      return respond(400, { error: 'invalid_location' });
    }
    recordedAt = Date.parse(payload.recorded_at as string);
    if (recordedAt > expiresAt) return respond(400, { error: 'invalid_location' });
    location = payload;
  } catch {
    return respond(400, { error: 'invalid_encrypted_payload' });
  }

  const { data: accepted, error: locationError } = await client.rpc('record_hunting_dog_location', {
    p_device_id: originDevice.id,
    p_latitude: location.latitude,
    p_longitude: location.longitude,
    p_accuracy: location.accuracy,
    p_recorded_at: new Date(recordedAt).toISOString()
  });
  if (locationError) {
    if (locationError.message.includes('Jagdmodus')) return respond(409, { error: 'hunting_mode_inactive' });
    if (locationError.message.includes('Ungueltige Positionsdaten')) return respond(400, { error: 'invalid_location' });
    return respond(503, { error: 'service_unavailable' });
  }

  await client.from('hunting_dog_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', relayDevice.id)
    .is('revoked_at', null);

  return respond(200, {
    accepted: Boolean(accepted),
    message_id: messageId,
    received_at: new Date().toISOString()
  });
});