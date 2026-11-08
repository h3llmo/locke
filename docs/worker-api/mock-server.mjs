// Mock of Locke's worker API (locke-worker/1, docs/worker-api.md) for building and testing a worker.
// Node.js >= 20, no dependencies. Plain HTTP: local testing only.
//
//   docker run --rm -p 8787:8787 -v "$PWD:/m:ro" -e MOCK_IMAGES=/m/images node:22-alpine node /m/mock-server.mjs
//
// Env: PORT (8787), MOCK_WORKER_KEY (printed at start), MOCK_JOBS (3 basic jobs queued at start),
//      MOCK_IMAGES (optional folder: target.png|jpg and face1..face8.png|jpg; default: a 1x1 PNG, which makes a
//      real engine answer no_face_found), MOCK_OUT (optional folder where decrypted results are written).
// Extra (mock only, same bearer key): POST /mock/enqueue?scenario=basic|two_characters|cancel|bad_params, GET /mock/state.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aad, b64u, fingerprint, open, seal, wrapJobKey } from './locke-worker-crypto.mjs';

const PREFIX = '/apps/locke/api/worker/v1';
const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.MOCK_WORKER_KEY ?? `lkw_${randomBytes(32).toString('base64url')}`;
const WORKER_ID = 'wrk_mock';
const S = { claimWaitMaxSeconds: 30, heartbeatSeconds: 30, offlineAfterSeconds: 60, leaseSeconds: 60,
  progressIntervalSeconds: 15, maxConcurrency: 1, maxInputBytes: 25 * 2 ** 20, maxResultBytes: 25 * 2 ** 20,
  maxJobSeconds: { face_swap: 600, generate: 1800, enhance: 600, blur: 300 } };
const MAX_ATTEMPTS = 3;
const FAIL_CODES = new Set(['unsupported', 'invalid_input', 'decrypt_failed', 'no_face_found', 'out_of_memory',
  'model_missing', 'engine_unavailable', 'timeout', 'cancelled', 'internal']);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const worker = { publicKey: null, capabilities: null, accepting: false, lastSeenAt: null };
const jobs = new Map(); // jobId -> job
const waiters = new Set();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const newId = (p) => `${p}_${randomBytes(9).toString('base64url')}`;

function image(name) {
  const dir = process.env.MOCK_IMAGES;
  if (!dir || !existsSync(dir)) return PIXEL;
  const file = readdirSync(dir).find((f) => f.replace(/\.(png|jpe?g)$/i, '') === name);
  return file ? readFileSync(join(dir, file)) : PIXEL;
}

function enqueue(scenario = 'basic') {
  const jobId = newId('job');
  const jobKey = randomBytes(32);
  const inputs = new Map();
  const add = (plain) => { const id = newId('in'); inputs.set(id, plain); return id; };
  const target = add(image('target'));
  const character = (ref, faceNames, gender, age) => {
    const faces = faceNames.map((n) => add(image(n)));
    return { ref, faces, mainFace: faces[0], gender, age };
  };
  const characters = scenario === 'two_characters'
    ? [character('ch_1', ['face1', 'face2'], 'woman', 'adult'), character('ch_2', ['face3'], 'man', 'any')]
    : [character('ch_1', ['face1'], 'any', 'any')];
  const params = { v: 1, type: 'face_swap', image: target, match: 'largest', characters, output: { format: 'png' } };
  const paramsText = scenario === 'bad_params' ? '{"v":1,"type":"face_swap"' : JSON.stringify(params);
  const job = {
    jobId, scenario, type: 'face_swap', jobKey, status: 'queued', attempt: 0, lease: null, results: new Map(),
    progressCalls: 0,
    params: b64u.enc(seal(jobKey, Buffer.from(paramsText, 'utf8'), aad.params(jobId))),
    inputs: new Map([...inputs].map(([id, plain]) => [id, seal(jobKey, plain, aad.input(jobId, id))])),
  };
  jobs.set(jobId, job);
  log(`queued ${jobId} (${scenario})`);
  for (const w of waiters) w();
  return job;
}

function expireLeases() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.lease.expiresAt <= now) {
      log(`lease expired on ${job.jobId} (attempt ${job.attempt})`);
      requeueOrFail(job, 'lease_expired', true);
    }
  }
}
setInterval(expireLeases, 1000).unref();

function requeueOrFail(job, code, retryable) {
  job.lease = null;
  job.results.clear();
  if (retryable && job.attempt < MAX_ATTEMPTS) { job.status = 'queued'; for (const w of waiters) w(); }
  else { job.status = 'failed'; job.failure = code; }
  log(`${job.jobId} -> ${job.status} (${code})`);
}

function claimable(types) {
  return [...jobs.values()].find((j) => j.status === 'queued' && (!types || types.includes(j.type)));
}

function leaseFor(job) {
  job.status = 'running';
  job.attempt += 1;
  job.results.clear();
  const now = Date.now();
  job.deadline = now + S.maxJobSeconds[job.type] * 1000;
  job.lease = { id: newId('lse'), expiresAt: Math.min(now + S.leaseSeconds * 1000, job.deadline) };
  log(`claimed ${job.jobId} attempt ${job.attempt}`);
  return {
    jobId: job.jobId, leaseId: job.lease.id, leaseExpiresAt: new Date(job.lease.expiresAt).toISOString(),
    deadlineAt: new Date(job.deadline).toISOString(), attempt: job.attempt, maxAttempts: MAX_ATTEMPTS, type: job.type,
    envelope: wrapJobKey(job.jobId, job.jobKey, worker.publicKey),
    params: job.params,
    inputs: [...job.inputs].map(([id, blob]) => ({ id, bytes: blob.length })),
    maxResults: 1,
  };
}

function renew(job) {
  job.lease.expiresAt = Math.min(Date.now() + S.leaseSeconds * 1000, job.deadline);
}

class HttpError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.body = { error: code, ...extra }; }
}

async function body(req, limit, raw = false) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'too_large'); chunks.push(c); }
  const buf = Buffer.concat(chunks);
  if (raw) return buf;
  if (!buf.length) return {};
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required');
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
}

function runningJob(jobId, leaseId) {
  expireLeases();
  const job = jobs.get(jobId);
  if (!job) throw new HttpError(404, 'job_not_found');
  if (job.status !== 'running' || job.lease?.id !== leaseId) throw new HttpError(409, 'lease_lost');
  return job;
}

const routes = [
  ['POST', /^\/hello$/, async (req) => {
    const b = await body(req, 64 * 1024);
    if (b.protocol !== 'locke-worker/1') throw new HttpError(400, 'unsupported_protocol');
    let pk; try { pk = b64u.dec(b.publicKey); } catch { pk = null; }
    if (!pk || pk.length !== 32) throw new HttpError(400, 'invalid_public_key');
    if (typeof b.capabilities !== 'object' || !b.capabilities) throw new HttpError(400, 'invalid_capabilities');
    if (worker.publicKey && !worker.publicKey.equals(pk)) log('public key changed (real Locke: pending_approval)');
    Object.assign(worker, { publicKey: pk, capabilities: b.capabilities, accepting: !!b.accepting });
    log(`hello from ${b.software?.name}/${b.software?.version}, key ${fingerprint(pk)}, faceSwap=${JSON.stringify(b.capabilities.faceSwap ?? null)}`);
    return [200, { workerId: WORKER_ID, keyStatus: 'active', mode: 'test', fingerprint: fingerprint(pk),
      serverTime: new Date().toISOString(), settings: S }];
  }],
  ['POST', /^\/heartbeat$/, async (req) => {
    const b = await body(req, 16 * 1024);
    if (typeof b.accepting !== 'boolean') throw new HttpError(400, 'invalid_body');
    worker.accepting = b.accepting;
    const queued = [...jobs.values()].filter((j) => j.status === 'queued').length;
    return [200, { keyStatus: 'active', queued, serverTime: new Date().toISOString() }];
  }],
  ['POST', /^\/jobs\/claim$/, async (req) => {
    const b = await body(req, 16 * 1024);
    if (!worker.publicKey) throw new HttpError(409, 'hello_required');
    const wait = Math.max(0, Math.min(Number(b.waitSeconds ?? 0), S.claimWaitMaxSeconds));
    const types = Array.isArray(b.types) ? b.types : null;
    if ([...jobs.values()].filter((j) => j.status === 'running').length >= S.maxConcurrency) {
      throw new HttpError(409, 'concurrency_limit');
    }
    let job = claimable(types);
    if (!job && wait > 0) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); waiters.delete(done); resolve(); };
        const t = setTimeout(done, wait * 1000);
        waiters.add(done);
        req.on('close', done);
      });
      job = claimable(types);
    }
    return job ? [200, leaseFor(job)] : [204];
  }],
  ['GET', /^\/jobs\/([\w-]+)\/inputs\/([\w-]+)$/, async (req, [jobId, inputId]) => {
    const job = runningJob(jobId, req.headers['x-locke-lease']);
    const blob = job.inputs.get(inputId);
    if (!blob) throw new HttpError(404, 'input_not_found');
    renew(job);
    return [200, blob];
  }],
  ['POST', /^\/jobs\/([\w-]+)\/progress$/, async (req, [jobId]) => {
    const b = await body(req, 16 * 1024);
    const job = runningJob(jobId, b.leaseId);
    if (b.progress !== null && b.progress !== undefined && !(b.progress >= 0 && b.progress <= 1)) throw new HttpError(400, 'invalid_progress');
    renew(job);
    job.progressCalls += 1;
    const cancel = job.scenario === 'cancel' && job.progressCalls >= 2;
    return [200, { leaseExpiresAt: new Date(job.lease.expiresAt).toISOString(), cancel }];
  }],
  ['PUT', /^\/jobs\/([\w-]+)\/results\/(\d+)$/, async (req, [jobId, nText]) => {
    const job = runningJob(jobId, req.headers['x-locke-lease']);
    const n = Number(nText);
    if (n < 1 || n > 1 || String(n) !== nText) throw new HttpError(400, 'invalid_result_number');
    const blob = await body(req, S.maxResultBytes, true);
    let plain;
    try { plain = open(job.jobKey, blob, aad.result(jobId, n)); } catch { throw new HttpError(422, 'decrypt_failed'); }
    const kind = plain.subarray(0, 8).equals(PIXEL.subarray(0, 8)) ? 'png' : plain[0] === 0xff && plain[1] === 0xd8 ? 'jpeg' : null;
    if (!kind) throw new HttpError(422, 'unsupported_format');
    const leaks = metadataChunks(plain, kind);
    if (leaks.length) { log(`${jobId} result ${n} rejected: metadata ${leaks.join(', ')}`); throw new HttpError(422, 'metadata_present'); }
    renew(job);
    job.results.set(n, plain);
    if (process.env.MOCK_OUT) writeFileSync(join(process.env.MOCK_OUT, `${jobId}-${n}.${kind}`), plain);
    log(`result ${n} for ${jobId}: ${kind}, ${plain.length} bytes`);
    return [200, { n, bytes: blob.length }];
  }],
  ['POST', /^\/jobs\/([\w-]+)\/complete$/, async (req, [jobId]) => {
    const b = await body(req, 16 * 1024);
    const job = jobs.get(jobId);
    if (job?.status === 'done' && job.doneLease === b.leaseId) return [200, {}]; // idempotent repeat
    runningJob(jobId, b.leaseId);
    const count = b.resultCount;
    if (!Number.isInteger(count) || count < 1 || count > 1) throw new HttpError(400, 'invalid_result_count');
    for (let n = 1; n <= count; n++) if (!job.results.has(n)) throw new HttpError(422, 'missing_result', { n });
    Object.assign(job, { status: 'done', doneLease: b.leaseId, lease: null });
    log(`done ${jobId}`);
    return [200, {}];
  }],
  ['POST', /^\/jobs\/([\w-]+)\/fail$/, async (req, [jobId]) => {
    const b = await body(req, 16 * 1024);
    const job = runningJob(jobId, b.leaseId);
    if (!FAIL_CODES.has(b.code) || typeof b.retryable !== 'boolean') throw new HttpError(400, 'invalid_body');
    log(`fail ${jobId}: ${b.code}${b.stage ? ` at ${b.stage}` : ''}, retryable=${b.retryable}`);
    requeueOrFail(job, b.code, b.retryable && b.code !== 'cancelled');
    return [200, {}];
  }],
];

function metadataChunks(buf, kind) {
  const found = [];
  if (kind === 'png') {
    for (let i = 8; i + 8 <= buf.length;) {
      const len = buf.readUInt32BE(i); const type = buf.toString('latin1', i + 4, i + 8);
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) found.push(type);
      i += 12 + len;
    }
  } else {
    for (let i = 2; i + 4 <= buf.length && buf[i] === 0xff;) {
      const marker = buf[i + 1]; if (marker === 0xda) break;
      if (marker === 0xe1) found.push('APP1 (EXIF/XMP)'); if (marker === 0xfe) found.push('COM');
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return found;
}

createServer(async (req, res) => {
  const send = (status, payload) => {
    if (payload === undefined) return res.writeHead(status).end();
    if (Buffer.isBuffer(payload)) return res.writeHead(status, { 'content-type': 'application/octet-stream' }).end(payload);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  };
  try {
    if (req.headers.authorization !== `Bearer ${KEY}`) throw new HttpError(401, 'invalid_key');
    const url = new URL(req.url, 'http://mock');
    worker.lastSeenAt = Date.now();
    if (url.pathname === '/mock/enqueue' && req.method === 'POST') return send(200, { jobId: enqueue(url.searchParams.get('scenario') ?? 'basic').jobId });
    if (url.pathname === '/mock/state' && req.method === 'GET') {
      return send(200, { accepting: worker.accepting, jobs: [...jobs.values()].map((j) => ({ jobId: j.jobId, scenario: j.scenario, status: j.status, attempt: j.attempt, failure: j.failure })) });
    }
    if (!url.pathname.startsWith(PREFIX)) throw new HttpError(404, 'not_found');
    const path = url.pathname.slice(PREFIX.length);
    for (const [method, re, handler] of routes) {
      const m = path.match(re);
      if (m && req.method === method) { const [status, payload] = await handler(req, m.slice(1)); return send(status, payload); }
    }
    throw new HttpError(404, 'not_found');
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, err.body);
    log('mock error', err); send(500, { error: 'internal' });
  }
}).listen(PORT, () => {
  for (let i = 0; i < Number(process.env.MOCK_JOBS ?? 3); i++) enqueue('basic');
  log(`mock Locke worker API on http://0.0.0.0:${PORT}${PREFIX}`);
  log(`worker key: ${KEY}`);
});
