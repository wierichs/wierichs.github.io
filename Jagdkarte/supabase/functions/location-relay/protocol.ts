export const MAX_BODY_BYTES = 16_384;
export const DIRECTORY_LIFETIME_MS = 120_000;
export const PARTICIPANT_LIFETIME_MS = 90_000;
export const RECEIPT_LIFETIME_MS = 86_400_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._-]{1,64}$/;
const signingAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const encryptionAlgorithm = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

export type JsonRecord = Record<string, unknown>;
export type RelayEnvelope = {
  action: 'relay'; origin_device_id: string; message_id: string; expires_at: string;
  key_id: string; encrypted_key: string; nonce: string; ciphertext: string; signature: string;
};
export type SignedDocument = { action: 'relay_document'; key_id: string; document: string; signature: string };
export type RelayLocation = {
  latitude: number; longitude: number; accuracy: number; recorded_at: string; sequence: string | null;
  sharing_epoch: string | null;
};

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 180_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_base64');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error('noncanonical_base64');
  return bytes;
}

function canonicalInstant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('invalid_time');
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) throw new Error('invalid_time');
  return instant;
}

export function parseEnvelope(value: unknown, now = Date.now()): RelayEnvelope {
  if (!isRecord(value) || value.action !== 'relay' || !isUuid(value.origin_device_id) || !isUuid(value.message_id) ||
    typeof value.key_id !== 'string' || !keyPattern.test(value.key_id)) throw new Error('invalid_envelope');
  if (encoder.encode(JSON.stringify(value)).length > 8192) throw new Error('envelope_too_large');
  const expiresAt = canonicalInstant(value.expires_at);
  if (expiresAt <= now || expiresAt > now + RECEIPT_LIFETIME_MS) throw new Error('message_expired');
  const encryptedKey = decodeBase64Url(value.encrypted_key);
  const nonce = decodeBase64Url(value.nonce);
  const ciphertext = decodeBase64Url(value.ciphertext);
  const signature = decodeBase64Url(value.signature);
  if (encryptedKey.length < 256 || encryptedKey.length > 1024 || nonce.length !== 12 ||
    ciphertext.length < 17 || ciphertext.length > 4112 || signature.length < 256 || signature.length > 512) {
    throw new Error('invalid_envelope');
  }
  return {
    action: 'relay', origin_device_id: value.origin_device_id.toLowerCase(), message_id: value.message_id.toLowerCase(),
    expires_at: value.expires_at as string, key_id: value.key_id,
    encrypted_key: value.encrypted_key as string, nonce: value.nonce as string,
    ciphertext: value.ciphertext as string, signature: value.signature as string
  };
}

export function signingInput(envelope: RelayEnvelope): Uint8Array<ArrayBuffer> {
  return encoder.encode(['dog-location-relay-v1', envelope.origin_device_id.toLowerCase(), envelope.message_id.toLowerCase(),
    envelope.expires_at, envelope.key_id, envelope.encrypted_key, envelope.nonce, envelope.ciphertext].join('\n'));
}

export async function importSigningKey(encoded: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey('spki', decodeBase64Url(encoded), signingAlgorithm, false, ['verify']);
  const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (bits < 2048 || bits > 4096) throw new Error('invalid_signing_key');
  return key;
}

export async function verifyEnvelope(envelope: RelayEnvelope, publicKey: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(signingAlgorithm, await importSigningKey(publicKey),
      decodeBase64Url(envelope.signature), signingInput(envelope));
  } catch { return false; }
}

export async function envelopeDigest(envelope: RelayEnvelope): Promise<string> {
  const bytes = encoder.encode(new TextDecoder().decode(signingInput(envelope)) + '\n' + envelope.signature);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function decryptPayload(envelope: RelayEnvelope, privateKey: string): Promise<JsonRecord> {
  const key = await crypto.subtle.importKey('pkcs8', decodeBase64Url(privateKey), encryptionAlgorithm, false, ['decrypt']);
  const aesBytes = await crypto.subtle.decrypt(encryptionAlgorithm, key, decodeBase64Url(envelope.encrypted_key));
  if (aesBytes.byteLength !== 32) throw new Error('invalid_content_key');
  const aesKey = await crypto.subtle.importKey('raw', aesBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64Url(envelope.nonce), tagLength: 128 },
    aesKey, decodeBase64Url(envelope.ciphertext));
  if (plaintext.byteLength > 4096) throw new Error('payload_too_large');
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  if (!isRecord(value)) throw new Error('invalid_location');
  return value;
}

export function validateLocation(payload: JsonRecord, kind: 'dog' | 'participant', profileId: string,
  expiresAt: string, now = Date.now()): RelayLocation {
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const accuracy = payload.accuracy;
  const recordedAt = canonicalInstant(payload.recorded_at);
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 5000) throw new Error('invalid_location');
  if (kind === 'participant') {
    if (payload.message_type !== 'participant.location' || payload.profile_id !== profileId ||
      !isUuid(payload.sharing_epoch) ||
      typeof payload.sequence !== 'string' || !/^[1-9][0-9]{0,15}$/.test(payload.sequence) ||
      !Number.isSafeInteger(Number(payload.sequence)) || recordedAt > now + 30_000 ||
      recordedAt <= now - PARTICIPANT_LIFETIME_MS || canonicalInstant(expiresAt) > recordedAt + PARTICIPANT_LIFETIME_MS) {
      throw new Error('invalid_participant_location');
    }
  } else if ((payload.message_type !== undefined && payload.message_type !== 'dog.location') ||
    recordedAt > now + 300_000 || recordedAt < now - RECEIPT_LIFETIME_MS) throw new Error('invalid_dog_location');
  return { latitude, longitude, accuracy, recorded_at: payload.recorded_at as string,
    sequence: kind === 'participant' ? payload.sequence as string : null,
    sharing_epoch: kind === 'participant' ? payload.sharing_epoch as string : null };
}

export async function signDocument(body: JsonRecord, keyId: string, privateKey: string): Promise<SignedDocument> {
  if (!keyPattern.test(keyId)) throw new Error('invalid_key_id');
  const document = encodeBase64Url(encoder.encode(JSON.stringify(body)));
  const key = await crypto.subtle.importKey('pkcs8', decodeBase64Url(privateKey), signingAlgorithm, false, ['sign']);
  const signature = await crypto.subtle.sign(signingAlgorithm, key, encoder.encode(['location-relay-document-v1', keyId, document].join('\n')));
  return { action: 'relay_document', key_id: keyId, document, signature: encodeBase64Url(new Uint8Array(signature)) };
}

export async function verifyDocument(document: SignedDocument, publicKey: string): Promise<JsonRecord | null> {
  try {
    if (document.action !== 'relay_document' || !keyPattern.test(document.key_id)) return null;
    const valid = await crypto.subtle.verify(signingAlgorithm, await importSigningKey(publicKey), decodeBase64Url(document.signature),
      encoder.encode(['location-relay-document-v1', document.key_id, document.document].join('\n')));
    if (!valid) return null;
    const body: unknown = JSON.parse(decoder.decode(decodeBase64Url(document.document)));
    return isRecord(body) ? body : null;
  } catch { return null; }
}

export async function readBody(request: Request): Promise<JsonRecord> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.length;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('payload_too_large'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!isRecord(value)) throw new Error('invalid_payload');
  return value;
}