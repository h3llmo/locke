// End-to-end test of Locke's job queue and worker API against a running Ilven deployment that includes Locke.
// Plays the admin, a user (alice) and a GPU worker. Cleans up what it creates.
// Put real GPU workers back in test mode first: a live one could take the user jobs this test queues for its own worker.
//   docker run --rm --network ilven_default -v ilven_secrets:/s:ro -v "$PWD:/l:ro" node:22-alpine node /l/test/e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { aad, b64u, generateWorkerKeyPair, open, seal, unwrapJobKey } from "../docs/worker-api/locke-worker-crypto.mjs";

const BASE = process.env.BASE_URL ?? "http://gateway";
const TOKEN_URL = process.env.KEYCLOAK_TOKEN_URL ?? "http://keycloak:8080/auth/realms/ilven/protocol/openid-connect/token";
const API = `${BASE}/apps/locke/api`;
const W = `${API}/worker/v1`;

async function token(user) {
  const password = readFileSync(`${process.env.SECRETS_DIR ?? "/s"}/keycloak-users/${user}`, "utf8").trim();
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "ilven-e2e", username: user, password, scope: "openid" }) });
  assert.equal(res.status, 200, `token for ${user}`);
  return (await res.json()).access_token;
}

async function call(method, url, { auth, json, form, bytes, lease } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (json) headers["content-type"] = "application/json";
  if (bytes) headers["content-type"] = "application/octet-stream";
  if (lease) headers["x-locke-lease"] = lease;
  const res = await fetch(url, { method, headers, body: json ? JSON.stringify(json) : form ?? bytes });
  const type = res.headers.get("content-type") ?? "";
  const body = res.status === 204 ? null : type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, type };
}

// A tiny valid PNG (1×1) and the same PNG with a tEXt chunk, as Fooocus writes prompts.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PNG_TEXT = Buffer.concat([PNG.subarray(0, 33), Buffer.from("0000000c74455874707200686964646e00000000", "hex"), PNG.subarray(33)]);

const CAPS = {
  maxConcurrency: 1, resultFormats: ["png", "jpeg"],
  faceSwap: { maxCharacters: 2, maxFacesPerCharacter: 8, genders: ["any", "woman", "man"], ages: ["any", "young", "adult", "senior"], ageAliases: { young: "adult" }, distinctFilters: true },
  generate: null, enhance: null, blur: null, edit: null,
};

let admin, alice, workerId, workerKey;
const keys = generateWorkerKeyPair();
const cleanup = { jobs: [] };

const hello = (key = workerKey, publicKey = keys.publicKey) => call("POST", `${W}/hello`, { auth: key, json: {
  protocol: "locke-worker/1", software: { name: "e2e-worker", version: "1" }, publicKey: b64u.enc(publicKey),
  gpu: { name: "none", vramMb: 0 }, accepting: true, capabilities: CAPS } });
const claim = (wait = 5) => call("POST", `${W}/jobs/claim`, { auth: workerKey, json: { waitSeconds: wait, types: ["face_swap"] } });

/** Runs one claimed job like a worker: decrypt, read inputs, report progress, upload `result` (default: target image). */
async function work(job, { result, complete = true } = {}) {
  const jobKey = unwrapJobKey(job.jobId, job.envelope, keys.privateKey);
  const params = JSON.parse(open(jobKey, b64u.dec(job.params), aad.params(job.jobId)).toString("utf8"));
  assert.equal(params.type, "face_swap");
  const target = await call("GET", `${W}/jobs/${job.jobId}/inputs/${params.image}`, { auth: workerKey, lease: job.leaseId });
  assert.equal(target.status, 200);
  const image = open(jobKey, target.body, aad.input(job.jobId, params.image));
  const p = await call("POST", `${W}/jobs/${job.jobId}/progress`, { auth: workerKey, json: { leaseId: job.leaseId, progress: 0.5 } });
  assert.equal(p.status, 200);
  assert.equal(p.body.cancel, false);
  const up = await call("PUT", `${W}/jobs/${job.jobId}/results/1`, { auth: workerKey, lease: job.leaseId, bytes: seal(jobKey, result ?? image, aad.result(job.jobId, 1)) });
  if (complete) {
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const done = await call("POST", `${W}/jobs/${job.jobId}/complete`, { auth: workerKey, json: { leaseId: job.leaseId, resultCount: 1 } });
    assert.equal(done.status, 200);
    // Idempotent.
    assert.equal((await call("POST", `${W}/jobs/${job.jobId}/complete`, { auth: workerKey, json: { leaseId: job.leaseId, resultCount: 1 } })).status, 200);
  }
  return { params, image, upload: up };
}

function faceSwapForm(characters, files) {
  const form = new FormData();
  form.set("params", JSON.stringify({ type: "face_swap", image: "target", characters }));
  for (const [name, data] of Object.entries(files)) form.set(name, new Blob([data], { type: "image/png" }), `${name}.png`);
  return form;
}

test("setup: tokens, admin-only worker management", async () => {
  admin = await token("admin");
  alice = await token("alice");
  assert.equal((await call("GET", `${API}/me`, { auth: alice })).body.isAdmin, false);
  assert.equal((await call("POST", `${API}/admin/workers`, { auth: alice, json: { name: "x" } })).status, 403);
  assert.equal((await call("GET", `${API}/jobs`)).status, 401);
  const created = await call("POST", `${API}/admin/workers`, { auth: admin, json: { name: "e2e worker", mode: "test" } });
  assert.equal(created.status, 201);
  workerId = created.body.worker.id;
  workerKey = created.body.workerKey;
  assert.match(workerKey, /^lkw_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.worker.keyStatus, "waiting_for_worker");
});

test("worker: bad key, hello, key pinning", async () => {
  assert.equal((await call("POST", `${W}/hello`, { auth: `lkw_${"A".repeat(43)}`, json: {} })).status, 401);
  assert.equal((await claim(0)).status, 409, "claim before hello");
  const h = await hello();
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.keyStatus, "active");
  assert.equal(h.body.mode, "test");
  assert.equal(h.body.settings.leaseSeconds, 60);
  // A different public key now needs an admin's approval; claims stop until then.
  const other = generateWorkerKeyPair();
  const h2 = await hello(workerKey, other.publicKey);
  assert.equal(h2.body.keyStatus, "pending_approval");
  assert.equal((await claim(0)).body.error, "key_pending");
  // Presenting the approved key again clears the pending one.
  assert.equal((await hello()).body.keyStatus, "active");
  const hb = await call("POST", `${W}/heartbeat`, { auth: workerKey, json: { accepting: true } });
  assert.equal(hb.status, 200);
  assert.equal(hb.body.keyStatus, "active");
});

test("test job: claim, decrypt, upload, complete; admin reads the result", async () => {
  const t = await call("POST", `${API}/admin/workers/${workerId}/test-job`, { auth: admin });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  cleanup.jobs.push([admin, t.body.id]);
  const c = await claim();
  assert.equal(c.status, 200);
  assert.equal(c.body.jobId, t.body.id);
  assert.equal(c.body.attempt, 1);
  const { params, image } = await work(c.body);
  assert.equal(params.test, true);
  assert.equal(params.characters[0].gender, "any");
  const view = await call("GET", `${API}/jobs/${t.body.id}`, { auth: admin });
  assert.equal(view.body.status, "done");
  assert.equal(view.body.resultCount, 1);
  const r = await call("GET", `${API}/jobs/${t.body.id}/results/1`, { auth: admin });
  assert.equal(r.status, 200);
  assert.equal(r.type, "image/png");
  assert.deepEqual(r.body, image);
  assert.equal((await call("GET", `${API}/jobs/${t.body.id}/results/1`, { auth: alice })).status, 404, "not alice's job");
});

test("results with metadata are rejected; lease checks; retryable failure re-queues", async () => {
  const t = await call("POST", `${API}/admin/workers/${workerId}/test-job`, { auth: admin });
  cleanup.jobs.push([admin, t.body.id]);
  const c = (await claim()).body;
  const { upload } = await work(c, { result: PNG_TEXT, complete: false });
  assert.equal(upload.status, 422);
  assert.equal(upload.body.error, "metadata_present");
  const jobKey = unwrapJobKey(c.jobId, c.envelope, keys.privateKey);
  const small = await call("PUT", `${W}/jobs/${c.jobId}/results/1`, { auth: workerKey, lease: c.leaseId, bytes: seal(jobKey, PNG, aad.result(c.jobId, 1)) });
  assert.equal(small.status, 422);
  assert.equal(small.body.error, "wrong_size", "a face swap result keeps the input's 512×512");
  assert.equal((await call("POST", `${W}/jobs/${c.jobId}/progress`, { auth: workerKey, json: { leaseId: "lse_wrong", progress: 0.1 } })).body.error, "lease_lost");
  assert.equal((await call("POST", `${W}/jobs/${c.jobId}/complete`, { auth: workerKey, json: { leaseId: c.leaseId, resultCount: 1 } })).body.error, "missing_result");
  assert.equal((await claim(0)).body.error, "concurrency_limit");
  const f = await call("POST", `${W}/jobs/${c.jobId}/fail`, { auth: workerKey, json: { leaseId: c.leaseId, code: "out_of_memory", retryable: true, stage: "engine" } });
  assert.equal(f.status, 200);
  const v = (await call("GET", `${API}/jobs/${c.jobId}`, { auth: admin })).body;
  assert.equal(v.status, "queued");
  assert.equal(v.attempt, 1);
  assert.equal(v.failureCode, "out_of_memory");
  assert.equal((await claim(0)).status, 204, "retry waits 30 s");
  assert.equal((await call("POST", `${W}/jobs/${c.jobId}/progress`, { auth: workerKey, json: { leaseId: c.leaseId } })).body.error, "lease_lost");
  const cancelled = await call("POST", `${API}/jobs/${c.jobId}/cancel`, { auth: admin });
  assert.equal(cancelled.body.status, "cancelled");
});

test("user jobs: refused when no live worker can do them, routed to the live worker otherwise", async () => {
  const files = { target: PNG, face1: PNG, face2: PNG };
  const one = [{ gender: "woman", age: "adult", faces: ["face1"], mainFace: "face1" }];
  // Real workers (e.g. windows-pilot) may already be live on this deployment: then only the e2e worker's own checks run.
  const othersLive = (await call("GET", `${API}/worker-status`, { auth: alice })).body.workers > 0;
  if (!othersLive) {
    const none = await call("POST", `${API}/jobs`, { auth: alice, form: faceSwapForm(one, { target: PNG, face1: PNG }) });
    assert.equal(none.status, 422);
    assert.equal(none.body.error, "no_worker");
  }
  assert.equal((await call("PATCH", `${API}/admin/workers/${workerId}`, { auth: admin, json: { mode: "live" } })).body.worker.mode, "live");

  const teen = await call("POST", `${API}/jobs`, { auth: alice, form: faceSwapForm([{ gender: "woman", age: "teen", faces: ["face1"], mainFace: "face1" }], { target: PNG, face1: PNG }) });
  assert.equal(teen.body.error, "unsupported");
  const overlap = await call("POST", `${API}/jobs`, { auth: alice, form: faceSwapForm([
    { gender: "woman", age: "young", faces: ["face1"], mainFace: "face1" },
    { gender: "woman", age: "adult", faces: ["face2"], mainFace: "face2" }], files) });
  assert.equal(overlap.body.error, "characters_overlap");
  const notImage = await call("POST", `${API}/jobs`, { auth: alice, form: faceSwapForm(one, { target: Buffer.from("hello"), face1: PNG }) });
  assert.equal(notImage.status, 415);

  // What users can ask for follows the live workers' capabilities.
  const opts = (await call("GET", `${API}/options`, { auth: alice })).body;
  assert.ok(opts.faceSwap.ages.includes("adult") && !opts.faceSwap.ages.includes("child"));
  assert.ok(opts.faceSwap.maxCharacters >= 2);
  if (!othersLive) {
    assert.equal(opts.generate, null, "the e2e worker doesn't generate");
    const genForm = new FormData();
    genForm.set("params", JSON.stringify({ type: "generate", positive: ["a lighthouse"], style: "photo-neutre" }));
    const gen = await call("POST", `${API}/jobs`, { auth: alice, form: genForm });
    assert.equal(gen.status, 422);
    assert.equal(gen.body.error, "unsupported");
  }
  const badGen = new FormData();
  badGen.set("params", JSON.stringify({ type: "generate", positive: [], style: "photo-neutre" }));
  assert.equal((await call("POST", `${API}/jobs`, { auth: alice, form: badGen })).body.error, "invalid_body");

  const ok = await call("POST", `${API}/jobs`, { auth: alice, form: faceSwapForm([
    { gender: "woman", age: "adult", faces: ["face1"], mainFace: "face1" },
    { gender: "man", age: "senior", faces: ["face2"], mainFace: "face2" }], files) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "queued");
  cleanup.jobs.push([alice, ok.body.id]);
  const status = await call("GET", `${API}/worker-status`, { auth: alice });
  assert.equal(status.body.queued >= 1, true);
  const hb = await call("POST", `${W}/heartbeat`, { auth: workerKey, json: { accepting: true } });
  assert.equal(hb.body.queuedByType.face_swap >= 1, true, JSON.stringify(hb.body));

  const c = await claim();
  assert.equal(c.body.jobId, ok.body.id);
  const { params } = await work(c.body);
  assert.equal(params.characters.length, 2);
  assert.deepEqual(params.characters.map((x) => x.ref), ["ch_1", "ch_2"]);
  assert.ok(!JSON.stringify(params).includes("face1"), "upload names never reach the worker");
  const list = await call("GET", `${API}/jobs`, { auth: alice });
  assert.equal(list.body.jobs.find((j) => j.id === ok.body.id).status, "done");
  assert.equal((await call("GET", `${API}/jobs/${ok.body.id}`, { auth: admin })).status, 404, "admins don't see users' jobs");
  const r = await call("GET", `${API}/jobs/${ok.body.id}/results/1`, { auth: alice });
  assert.equal(r.status, 200);
});

test("cancel while running reaches the worker", async () => {
  const t = await call("POST", `${API}/admin/workers/${workerId}/test-job`, { auth: admin });
  cleanup.jobs.push([admin, t.body.id]);
  const c = (await claim()).body;
  await call("POST", `${API}/jobs/${c.jobId}/cancel`, { auth: admin });
  const p = await call("POST", `${W}/jobs/${c.jobId}/progress`, { auth: workerKey, json: { leaseId: c.leaseId, progress: 0.2 } });
  assert.equal(p.body.cancel, true);
  await call("POST", `${W}/jobs/${c.jobId}/fail`, { auth: workerKey, json: { leaseId: c.leaseId, code: "cancelled", retryable: false } });
  assert.equal((await call("GET", `${API}/jobs/${c.jobId}`, { auth: admin })).body.status, "cancelled");
});

test("rate limit: 120 requests per minute per key, then 429", async () => {
  const bogus = `lkw_${b64u.enc(randomBytes(32))}`;
  let last;
  for (let i = 0; i < 121; i++) last = await call("POST", `${W}/heartbeat`, { auth: bogus, json: { accepting: false } });
  assert.equal(last.status, 429);
  assert.equal(last.body.error, "rate_limited");
});

test("rotating the key locks out the old one; cleanup", async () => {
  const r = await call("POST", `${API}/admin/workers/${workerId}/rotate-key`, { auth: admin });
  assert.equal(r.status, 200);
  assert.equal((await hello(workerKey)).status, 401);
  workerKey = r.body.workerKey;
  assert.equal((await hello()).body.keyStatus, "active");
  for (const [who, id] of cleanup.jobs) {
    const d = await call("DELETE", `${API}/jobs/${id}`, { auth: who === "admin" ? admin : who });
    assert.equal(d.status, 204, `delete ${id}: ${JSON.stringify(d.body)}`);
  }
  assert.equal((await call("DELETE", `${API}/admin/workers/${workerId}`, { auth: admin })).status, 204);
  assert.equal((await hello()).status, 401);
});
