import { handleRequest } from './index.ts';
import { encodeBase64Url, envelopeDigest, signingInput, verifyDocument, type RelayEnvelope } from './protocol.ts';

function assert(value: unknown): asserts value { if (!value) throw new Error('Assertion failed'); }
const values: Record<string, string> = {
  RELAY_ENCRYPTION_KEY_ID: 'test', RELAY_ENCRYPTION_PUBLIC_KEY: 'test', RELAY_ENCRYPTION_PRIVATE_KEY: 'test',
  RELAY_RECEIPT_KEY_ID: 'receipt', RELAY_RECEIPT_PUBLIC_KEY: 'test', RELAY_RECEIPT_PRIVATE_KEY: 'test',
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service', SUPABASE_ANON_KEY: 'test-anon'
};
const request = (body: unknown, token?: string) => new Request('https://example.org/location-relay', { method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

Deno.test('endpoint rejects missing credentials without accessing database', async () => {
  const response = await handleRequest(request({ action: 'directory' }), { env: name => values[name],
    fetch: () => { throw new Error('Unexpected database access'); } });
  assert(response.status === 401);
});

Deno.test('endpoint validates user JWT with auth service instead of trusting JWT claims', async () => {
  let authCalled = false;
  const response = await handleRequest(request({ action: 'directory' }, 'forged.jwt.token'), { env: name => values[name],
    fetch: async input => {
      assert(String(input).endsWith('/auth/v1/user'));
      authCalled = true;
      return new Response('{"message":"invalid jwt"}', { status: 401, headers: { 'content-type': 'application/json' } });
    } });
  assert(authCalled && response.status === 401);
});

Deno.test('methods, malformed actions and unconfigured deployment fail closed', async () => {
  assert((await handleRequest(new Request('https://example.org'), { env: () => undefined })).status === 405);
  assert((await handleRequest(request({ action: 'unknown' }), { env: () => undefined })).status === 400);
  assert((await handleRequest(request({ action: 'capabilities' }), { env: () => undefined })).status === 503);
});

Deno.test('authenticated gateway obtains signed receipt only after accepted database write', async () => {
  const signing = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const encryption = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey)));
  const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey)));
  const environment = { ...values,
    RELAY_ENCRYPTION_PUBLIC_KEY: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', encryption.publicKey))),
    RELAY_ENCRYPTION_PRIVATE_KEY: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', encryption.privateKey))),
    RELAY_RECEIPT_PUBLIC_KEY: publicKey, RELAY_RECEIPT_PRIVATE_KEY: privateKey };
  const now = new Date().toISOString();
  const gateway = crypto.randomUUID();
  const origin = crypto.randomUUID();
  const user = crypto.randomUUID();
  const profile = crypto.randomUUID();
  const epoch = crypto.randomUUID();
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const payload = { message_type: 'participant.location', profile_id: profile, sequence: '1', sharing_epoch: epoch,
    latitude: 51, longitude: 7, accuracy: 5, recorded_at: now };
  const envelope: RelayEnvelope = { action: 'relay', origin_device_id: origin, message_id: crypto.randomUUID(),
    expires_at: new Date(Date.parse(now) + 90_000).toISOString(), key_id: 'test',
    encrypted_key: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt('RSA-OAEP', encryption.publicKey,
      await crypto.subtle.exportKey('raw', aes)))), nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes,
      new TextEncoder().encode(JSON.stringify(payload))))), signature: '' };
  envelope.signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing.privateKey, signingInput(envelope))));
  let writes = 0;
  const dependencies = { env: (name: string) => environment[name as keyof typeof environment], fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    let response: unknown;
    if (url.pathname === '/auth/v1/user') response = { id: user, aud: 'authenticated', role: 'authenticated' };
    else if (url.pathname === '/rest/v1/rpc/resolve_hunting_relay_device') {
      const body = JSON.parse(String(init?.body));
      response = [{ device_id: body.p_device_id, profile_id: profile, device_kind: 'participant', public_key: publicKey,
        user_id: body.p_device_id === gateway ? user : crypto.randomUUID(), dog_id: null }];
    } else if (url.pathname === '/rest/v1/hunting_profiles') response = { hunting_mode: true };
    else if (url.pathname === '/rest/v1/rpc/record_hunting_relay_location') {
      const body = JSON.parse(String(init?.body));
      assert(body.p_origin_device_id === origin && body.p_gateway_device_id === gateway && body.p_sharing_epoch === epoch);
      assert(body.p_sequence === '1' && body.p_latitude === 51 && body.p_longitude === 7);
      assert(body.p_digest === await envelopeDigest(envelope));
      writes++;
      response = { accepted: true, received_at: now, position_applied: true };
    } else throw new Error('Unexpected API request');
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  } };
  const response = await handleRequest(request({ action: 'relay', device_id: gateway, envelope }, 'verified.jwt.token'), dependencies);
  assert(response.status === 200 && writes === 1);
  const receipt = await verifyDocument(await response.json(), publicKey);
  assert(receipt?.message_id === envelope.message_id && receipt.origin_device_id === origin && receipt.position_applied === true);
});