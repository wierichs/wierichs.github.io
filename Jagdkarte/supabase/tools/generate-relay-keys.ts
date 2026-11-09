import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBase64Url } from '../functions/location-relay/protocol.ts';

const destination = Deno.args[0];
if (!destination) throw new Error('Specify an output .env file outside the repository.');
const output = resolve(destination);
const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)));
if (output.toLowerCase().startsWith(repository.toLowerCase())) throw new Error('Secrets must be stored outside the repository.');
const signing = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const encode = async (format: 'spki' | 'pkcs8', key: CryptoKey) => encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey(format, key)));
const values = [
  `RELAY_RECEIPT_KEY_ID=receipt-${crypto.randomUUID()}`,
  `RELAY_RECEIPT_PUBLIC_KEY=${await encode('spki', signing.publicKey)}`,
  `RELAY_RECEIPT_PRIVATE_KEY=${await encode('pkcs8', signing.privateKey)}`
];
if (Deno.args.includes('--new-encryption')) {
  const encryption = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  values.push(`RELAY_ENCRYPTION_KEY_ID=encryption-${crypto.randomUUID()}`,
    `RELAY_ENCRYPTION_PUBLIC_KEY=${await encode('spki', encryption.publicKey)}`,
    `RELAY_ENCRYPTION_PRIVATE_KEY=${await encode('pkcs8', encryption.privateKey)}`);
}
const content = values.join('\n') + '\n';
await Deno.mkdir(dirname(output), { recursive: true });
await Deno.writeTextFile(output, content, { createNew: true, mode: 0o600 });
console.log('Relay key file created. Existing files are never overwritten. Restrict its file-system permissions.');