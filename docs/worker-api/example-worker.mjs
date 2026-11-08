// Minimal locke-worker/1 client, for reference and for testing mock-server.mjs. Its "engine" returns the target
// image unchanged. Node.js >= 20, no dependencies.
//   LOCKE_URL=http://localhost:8787/apps/locke/api/worker/v1 LOCKE_KEY=lkw_... node example-worker.mjs [--once]
import { randomBytes } from 'node:crypto';
import { aad, b64u, generateWorkerKeyPair, open, seal, unwrapJobKey } from './locke-worker-crypto.mjs';

const BASE = process.env.LOCKE_URL;
const KEY = process.env.LOCKE_KEY;
const ONCE = process.argv.includes('--once');
const keys = generateWorkerKeyPair(); // a real worker keeps it (encrypted) across restarts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { json, bytes, lease } = {}) {
  const headers = { authorization: `Bearer ${KEY}`, 'user-agent': 'example-worker/0.1 (locke-worker/1)' };
  if (json) headers['content-type'] = 'application/json';
  if (bytes) headers['content-type'] = 'application/octet-stream';
  if (lease) headers['x-locke-lease'] = lease;
  const res = await fetch(BASE + path, { method, headers, body: json ? JSON.stringify(json) : bytes, redirect: 'error' });
  const type = res.headers.get('content-type') ?? '';
  const payload = res.status === 204 ? null : type.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, payload };
}

async function runJob(job) {
  const jobKey = unwrapJobKey(job.jobId, job.envelope, keys.privateKey);
  try {
    const params = JSON.parse(open(jobKey, b64u.dec(job.params), aad.params(job.jobId)).toString('utf8'));
    if (params.type !== job.type) throw Object.assign(new Error(), { code: 'invalid_input' });
    const got = await call('GET', `/jobs/${job.jobId}/inputs/${params.image}`, { lease: job.leaseId });
    if (got.status !== 200) return console.log(`input: ${got.status} ${got.payload?.error}`);
    const target = open(jobKey, got.payload, aad.input(job.jobId, params.image));
    for (const p of [0.3, 0.6]) {
      await sleep(200);
      const r = await call('POST', `/jobs/${job.jobId}/progress`, { json: { leaseId: job.leaseId, progress: p } });
      if (r.status === 409 || r.status === 404) return console.log(`lease lost on ${job.jobId}`);
      if (r.payload.cancel) {
        await call('POST', `/jobs/${job.jobId}/fail`, { json: { leaseId: job.leaseId, code: 'cancelled', retryable: false } });
        return console.log(`cancelled ${job.jobId}`);
      }
    }
    const sealed = seal(jobKey, target, aad.result(job.jobId, 1), randomBytes(12));
    const put = await call('PUT', `/jobs/${job.jobId}/results/1`, { bytes: sealed, lease: job.leaseId });
    if (put.status !== 200) throw Object.assign(new Error(), { code: 'internal' });
    const done = await call('POST', `/jobs/${job.jobId}/complete`, { json: { leaseId: job.leaseId, resultCount: 1 } });
    console.log(`complete ${job.jobId}: ${done.status}`);
  } catch (err) {
    const code = err.code ?? (err.message?.includes('authenticate') ? 'decrypt_failed' : 'invalid_input');
    await call('POST', `/jobs/${job.jobId}/fail`, { json: { leaseId: job.leaseId, code, retryable: false, stage: 'params' } });
    console.log(`failed ${job.jobId}: ${code}`);
  } finally {
    jobKey.fill(0);
  }
}

const hello = await call('POST', '/hello', { json: {
  protocol: 'locke-worker/1', software: { name: 'example-worker', version: '0.1' },
  publicKey: b64u.enc(keys.publicKey), gpu: { name: 'none', vramMb: 0 }, accepting: true,
  capabilities: { maxConcurrency: 1, resultFormats: ['png', 'jpeg'], faceSwap: { maxCharacters: 2,
    genders: ['any', 'woman', 'man'], ages: ['any', 'young', 'adult', 'senior'], ageAliases: { young: 'adult' },
    distinctFilters: true, maxFacesPerCharacter: 8 } },
} });
console.log('hello', hello.status, hello.payload.keyStatus, hello.payload.fingerprint);
for (;;) {
  const claim = await call('POST', '/jobs/claim', { json: { waitSeconds: ONCE ? 1 : 30, types: ['face_swap'] } });
  if (claim.status === 200) await runJob(claim.payload);
  else if (claim.status === 204) { if (ONCE) break; }
  else { console.log('claim', claim.status, claim.payload?.error); await sleep(5000); }
}
