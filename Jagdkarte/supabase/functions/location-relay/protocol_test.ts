import {
  decodeBase64Url, decryptPayload, encodeBase64Url, envelopeDigest, parseEnvelope, readBody,
  signDocument, signingInput, validateLocation, verifyDocument, verifyEnvelope, type RelayEnvelope
} from './protocol.ts';

function assert(value: unknown, message = 'Assertion failed'): asserts value { if (!value) throw new Error(message); }
function rejects(action: () => unknown) { let failed = false; try { action(); } catch { failed = true; } assert(failed); }
const now = Date.parse('2026-11-02T10:00:00.000Z');
const profileId = 'c76274b7-e21a-440e-ad0d-c51c6f6345e0';
const participant = { message_type: 'participant.location', profile_id: profileId, sequence: '1',
  sharing_epoch: 'd76274b7-e21a-440e-ad0d-c51c6f6345e0',
  latitude: 51.2, longitude: 7.1, accuracy: 5, recorded_at: new Date(now).toISOString() };

async function fixture() {
  const signing = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const encryption = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, new TextEncoder().encode(JSON.stringify(participant)));
  const encryptedKey = await crypto.subtle.encrypt('RSA-OAEP', encryption.publicKey, await crypto.subtle.exportKey('raw', aes));
  const envelope: RelayEnvelope = { action: 'relay', origin_device_id: 'a16cb2bc-6dca-40bb-8e10-fc33b4d9272e',
    message_id: 'b6f0ca6c-cc23-44df-b231-51a7a29ad002', expires_at: new Date(now + 90_000).toISOString(), key_id: 'test-1',
    encrypted_key: encodeBase64Url(new Uint8Array(encryptedKey)), nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)), signature: '' };
  envelope.signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing.privateKey, signingInput(envelope))));
  return { envelope,
    publicKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey))),
    privateKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey))),
    decryptionKey: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', encryption.privateKey))) };
}

Deno.test('legacy envelope verifies and decrypts typed participant payload', async () => {
  const data = await fixture();
  const envelope = parseEnvelope(data.envelope, now);
  assert(await verifyEnvelope(envelope, data.publicKey));
  const payload = await decryptPayload(envelope, data.decryptionKey);
  assert(validateLocation(payload, 'participant', profileId, envelope.expires_at, now).sequence === '1');
  assert((await envelopeDigest(envelope)).length === 64);
});

Deno.test('signed metadata and encrypted positions cannot be changed', async () => {
  const data = await fixture();
  assert(!await verifyEnvelope({ ...data.envelope, message_id: crypto.randomUUID() }, data.publicKey));
  assert(!await verifyEnvelope({ ...data.envelope, expires_at: new Date(now + 60_000).toISOString() }, data.publicKey));
  const bytes = decodeBase64Url(data.envelope.ciphertext);
  bytes[0] ^= 1;
  assert(!await verifyEnvelope({ ...data.envelope, ciphertext: encodeBase64Url(bytes) }, data.publicKey));
});

Deno.test('expiry and malformed envelope encodings fail closed', async () => {
  const data = await fixture();
  rejects(() => parseEnvelope(data.envelope, now + 90_000));
  rejects(() => parseEnvelope({ ...data.envelope, nonce: '***' }, now));
  rejects(() => parseEnvelope({ ...data.envelope, signature: data.envelope.signature + '=' }, now));
  rejects(() => parseEnvelope({ ...data.envelope, expires_at: '2026-11-02T10:01:30Z' }, now));
});

Deno.test('participant type, group, age, sequence and lifetime are mandatory', () => {
  const expiry = new Date(now + 90_000).toISOString();
  validateLocation(participant, 'participant', profileId, expiry, now);
  for (const patch of [{ profile_id: crypto.randomUUID() }, { message_type: 'dog.location' }, { sequence: '0' },
    { sequence: 1 }, { sequence: '9007199254740992' }, { latitude: NaN }, { accuracy: -1 },
    { recorded_at: new Date(now - 90_000).toISOString() }, { recorded_at: new Date(now + 30_001).toISOString() }]) {
    rejects(() => validateLocation({ ...participant, ...patch }, 'participant', profileId, expiry, now));
  }
  rejects(() => validateLocation(participant, 'participant', profileId, new Date(now + 90_001).toISOString(), now));
});

Deno.test('legacy dogs remain supported but cannot claim participant messages', () => {
  const location = { latitude: 54, longitude: 9, accuracy: 12, recorded_at: new Date(now - 3_600_000).toISOString() };
  assert(validateLocation(location, 'dog', profileId, new Date(now + 1000).toISOString(), now).sequence === null);
  rejects(() => validateLocation(participant, 'dog', profileId, new Date(now + 1000).toISOString(), now));
});

Deno.test('signed directory and receipts reject modified content or key identity', async () => {
  const data = await fixture();
  const document = await signDocument({ document_type: 'receipt', message_id: data.envelope.message_id }, 'receipt-1', data.privateKey);
  assert((await verifyDocument(document, data.publicKey))?.message_id === data.envelope.message_id);
  assert(await verifyDocument({ ...document, key_id: 'other' }, data.publicKey) === null);
  assert(await verifyDocument({ ...document, document: encodeBase64Url(new TextEncoder().encode('{}')) }, data.publicKey) === null);
});

Deno.test('bounded request body rejects oversized data independently of headers', async () => {
  let failed = false;
  try { await readBody(new Request('https://example.org', { method: 'POST', body: 'x'.repeat(16_385) })); }
  catch { failed = true; }
  assert(failed);
  assert((await readBody(new Request('https://example.org', { method: 'POST', body: '{"action":"directory"}' }))).action === 'directory');
});