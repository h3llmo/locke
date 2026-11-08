// Test vectors for locke-worker/1 encryption (docs/worker-api.md §4).
//   node vectors.mjs           verify vectors.json against the reference implementation
//   node vectors.mjs --write   regenerate vectors.json (deterministic: same output every time)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aad, b64u, fingerprint, open, publicKeyOf, seal, unwrapJobKey, wrapJobKey, HKDF_INFO, ALG } from './locke-worker-crypto.mjs';

const file = fileURLToPath(new URL('./vectors.json', import.meta.url));
const det = (label, n = 32) => createHash('sha256').update(`locke-worker/v1 test vector|${label}`).digest().subarray(0, n);

function generate() {
  const jobId = 'job_test_0001';
  const inputId = 'in_test_target';
  const workerPrivateKey = det('worker private key');
  const workerPublicKey = publicKeyOf(workerPrivateKey);
  const ephemeralPrivateKey = det('ephemeral private key');
  const jobKey = det('job key');
  const params = JSON.stringify({
    v: 1, type: 'face_swap', image: inputId, match: 'largest',
    characters: [{ ref: 'ch_1', faces: ['in_test_face1'], mainFace: 'in_test_face1', gender: 'woman', age: 'adult' }],
    output: { format: 'png' },
  });
  const input = Buffer.from('opaque input bytes (a real job carries an image here)', 'utf8');
  const result = Buffer.from('opaque result bytes (a real job carries a PNG or JPEG here)', 'utf8');
  const envelope = wrapJobKey(jobId, jobKey, workerPublicKey, { ephemeralPrivateKey, nonce: det('nonce job-key', 12) });
  return {
    description: 'locke-worker/1 test vectors. Binary values are base64url without padding unless the field name ends in Hex/Utf8.',
    alg: ALG,
    hkdfInfoUtf8: HKDF_INFO,
    jobId,
    worker: {
      privateKey: b64u.enc(workerPrivateKey),
      publicKey: b64u.enc(workerPublicKey),
      fingerprint: fingerprint(workerPublicKey),
    },
    ephemeralPrivateKey: b64u.enc(ephemeralPrivateKey),
    jobKeyHex: jobKey.toString('hex'),
    envelope,
    params: {
      aadUtf8: aad.params(jobId),
      plaintextUtf8: params,
      sealed: b64u.enc(seal(jobKey, Buffer.from(params, 'utf8'), aad.params(jobId), det('nonce params', 12))),
    },
    input: {
      inputId,
      aadUtf8: aad.input(jobId, inputId),
      plaintextHex: input.toString('hex'),
      sealedHex: seal(jobKey, input, aad.input(jobId, inputId), det('nonce input', 12)).toString('hex'),
    },
    result: {
      n: 1,
      aadUtf8: aad.result(jobId, 1),
      nonceHex: det('nonce result', 12).toString('hex'),
      plaintextHex: result.toString('hex'),
      sealedHex: seal(jobKey, result, aad.result(jobId, 1), det('nonce result', 12)).toString('hex'),
    },
    mustFail: [
      { what: 'params opened with another job id in the AAD', aadUtf8: aad.params('job_test_0002') },
      { what: 'envelope unwrapped with jobId "job_test_0002"', jobId: 'job_test_0002' },
    ],
  };
}

function verify(v) {
  const fail = (msg) => { throw new Error(`vector mismatch: ${msg}`); };
  const workerPrivateKey = b64u.dec(v.worker.privateKey);
  if (b64u.enc(publicKeyOf(workerPrivateKey)) !== v.worker.publicKey) fail('worker public key');
  if (fingerprint(b64u.dec(v.worker.publicKey)) !== v.worker.fingerprint) fail('fingerprint');
  const jobKey = unwrapJobKey(v.jobId, v.envelope, workerPrivateKey);
  if (jobKey.toString('hex') !== v.jobKeyHex) fail('job key');
  if (open(jobKey, b64u.dec(v.params.sealed), v.params.aadUtf8).toString('utf8') !== v.params.plaintextUtf8) fail('params');
  if (open(jobKey, Buffer.from(v.input.sealedHex, 'hex'), v.input.aadUtf8).toString('hex') !== v.input.plaintextHex) fail('input');
  const sealedResult = seal(jobKey, Buffer.from(v.result.plaintextHex, 'hex'), v.result.aadUtf8, Buffer.from(v.result.nonceHex, 'hex'));
  if (sealedResult.toString('hex') !== v.result.sealedHex) fail('result');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  if (!throws(() => open(jobKey, b64u.dec(v.params.sealed), v.mustFail[0].aadUtf8))) fail('wrong AAD accepted');
  if (!throws(() => unwrapJobKey(v.mustFail[1].jobId, v.envelope, workerPrivateKey))) fail('wrong job id accepted');
}

if (process.argv.includes('--write')) {
  const v = generate();
  verify(v);
  writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
  console.log(`wrote ${file}`);
} else {
  const v = JSON.parse(readFileSync(file, 'utf8'));
  verify(v);
  if (JSON.stringify(v) !== JSON.stringify(generate())) throw new Error('vectors.json differs from the generator');
  console.log('all vectors OK');
}
