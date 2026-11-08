// Reference implementation of the locke-worker/1 encryption (docs/worker-api.md §4).
// Node.js >= 20, no dependencies. Used by vectors.mjs and mock-server.mjs; Locke's server ports it as is.
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';

export const ALG = 'X25519-HKDF-SHA256/A256GCM';
export const HKDF_INFO = 'locke-worker/v1 job-key';
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex'); // + 32-byte private key
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');          // + 32-byte public key
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** base64url without padding (RFC 4648 §5), strict on decode. */
export const b64u = {
  enc: (bytes) => Buffer.from(bytes).toString('base64url'),
  dec: (text) => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
      throw new Error('invalid base64url');
    }
    return Buffer.from(text, 'base64url');
  },
};

export const aad = {
  jobKey: (jobId) => `locke/v1|${id(jobId)}|job-key`,
  params: (jobId) => `locke/v1|${id(jobId)}|params`,
  input: (jobId, inputId) => `locke/v1|${id(jobId)}|input|${id(inputId)}`,
  result: (jobId, n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error('invalid result number');
    return `locke/v1|${id(jobId)}|result|${n}`;
  },
};
function id(value) {
  if (!ID_RE.test(value)) throw new Error('invalid id');
  return value;
}

const privateKeyObject = (raw) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_X25519, len32(raw)]), format: 'der', type: 'pkcs8' });
const publicKeyObject = (raw) =>
  createPublicKey({ key: Buffer.concat([SPKI_X25519, len32(raw)]), format: 'der', type: 'spki' });
function len32(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('X25519 keys are 32 bytes');
  return raw;
}

/** Raw 32-byte public key of a raw 32-byte private key. */
export function publicKeyOf(privateKey) {
  return createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519.length);
}

export function generateWorkerKeyPair() {
  const { privateKey } = generateKeyPairSync('x25519');
  const raw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_X25519.length);
  return { privateKey: Buffer.from(raw), publicKey: publicKeyOf(Buffer.from(raw)) };
}

/** Shown in both UIs: first 8 bytes of SHA-256(public key), hex, groups of 4. */
export function fingerprint(publicKey) {
  return createHash('sha256').update(len32(publicKey)).digest('hex').slice(0, 16).match(/.{4}/g).join(' ');
}

/** AES-256-GCM blob: nonce(12) || ciphertext || tag(16). AAD is the UTF-8 string from `aad`. */
export function seal(key, plaintext, aadText, nonce = randomBytes(12)) {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('bad key or nonce length');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aadText, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function open(key, blob, aadText) {
  if (key.length !== 32 || blob.length < 28) throw new Error('bad key or blob length');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAAD(Buffer.from(aadText, 'utf8'));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
}

function keyEncryptionKey(sharedSecret, epk, workerPublicKey) {
  if (sharedSecret.every((b) => b === 0)) throw new Error('low-order X25519 point');
  const salt = Buffer.concat([epk, workerPublicKey]); // 64 bytes
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(HKDF_INFO, 'utf8'), 32));
}

/** Locke side: seal a 32-byte job key for one worker. `ephemeralPrivateKey`/`nonce` only for test vectors. */
export function wrapJobKey(jobId, jobKey, workerPublicKey, { ephemeralPrivateKey, nonce } = {}) {
  if (jobKey.length !== 32) throw new Error('job key is 32 bytes');
  const ephemeral = ephemeralPrivateKey ?? generateWorkerKeyPair().privateKey;
  const epk = publicKeyOf(ephemeral);
  const shared = diffieHellman({ privateKey: privateKeyObject(ephemeral), publicKey: publicKeyObject(workerPublicKey) });
  const kek = keyEncryptionKey(shared, epk, workerPublicKey);
  return { alg: ALG, epk: b64u.enc(epk), wrappedKey: b64u.enc(seal(kek, jobKey, aad.jobKey(jobId), nonce)) };
}

/** Worker side: recover the job key from a claimed job's envelope. */
export function unwrapJobKey(jobId, envelope, workerPrivateKey) {
  if (envelope?.alg !== ALG) throw new Error('unsupported envelope alg');
  const epk = b64u.dec(envelope.epk);
  const workerPublicKey = publicKeyOf(workerPrivateKey);
  const shared = diffieHellman({ privateKey: privateKeyObject(workerPrivateKey), publicKey: publicKeyObject(epk) });
  const kek = keyEncryptionKey(shared, epk, workerPublicKey);
  const jobKey = open(kek, b64u.dec(envelope.wrappedKey), aad.jobKey(jobId));
  if (jobKey.length !== 32) throw new Error('job key is 32 bytes');
  return jobKey;
}
