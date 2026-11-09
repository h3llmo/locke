// End-to-end test of characters, saved prompts, schedules, Locke as a vault source, the automation key and workflows,
// against a running Ilven deployment that includes Locke and Locke Vault (with Locke in VAULT_SOURCES).
// Its own GPU worker announces a style ("e2e-style") and an age ("child") that real workers don't, so real live
// workers (windows-pilot) never receive these jobs and can stay live. Cleans up what it creates. Takes ~3 minutes.
//   docker run --rm --network ilven_default -v ilven_secrets:/s:ro -v "$PWD:/l:ro" node:22-alpine node /l/test/e2e-features.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aad, b64u, generateWorkerKeyPair, open, seal, unwrapJobKey } from "../docs/worker-api/locke-worker-crypto.mjs";

const BASE = process.env.BASE_URL ?? "http://gateway";
const TOKEN_URL = process.env.KEYCLOAK_TOKEN_URL ?? "http://keycloak:8080/auth/realms/ilven/protocol/openid-connect/token";
const API = `${BASE}/apps/locke/api`;
const V = `${BASE}/apps/locke-vault/api`;
const W = `${API}/worker/v1`;

async function token(user) {
  const password = readFileSync(`${process.env.SECRETS_DIR ?? "/s"}/keycloak-users/${user}`, "utf8").trim();
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "ilven-e2e", username: user, password, scope: "openid" }) });
  assert.equal(res.status, 200, `token for ${user}`);
  return (await res.json()).access_token;
}
async function call(method, url, { auth, json, form, bytes, type, lease } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (json) headers["content-type"] = "application/json";
  if (bytes) headers["content-type"] = type ?? "application/octet-stream";
  if (lease) headers["x-locke-lease"] = lease;
  const res = await fetch(url, { method, headers, body: json ? JSON.stringify(json) : form ?? bytes });
  const ct = res.headers.get("content-type") ?? "";
  const body = res.status === 204 ? null : ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, type: ct };
}
const until = async (what, fn, ms = 150_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const CAPS = {
  maxConcurrency: 1, resultFormats: ["png", "jpeg"],
  faceSwap: { maxCharacters: 2, maxFacesPerCharacter: 8, genders: ["any", "woman", "man"], ages: ["any", "child", "adult"], distinctFilters: true },
  generate: { styles: [{ id: "e2e-style", label: "E2E" }], counts: [1], character: false },
  enhance: null, blur: null, upscale: { scales: [2] }, edit: null,
};
const keys = generateWorkerKeyPair();
let admin, alice, workerId, workerKey;
const made = { jobs: new Set(), character: null, prompt: null, workflow: null, items: new Set(), automation: false };

async function workOne(types, expect) {
  const c = await until(`a ${types} job for the e2e worker`, async () => {
    const r = await call("POST", `${W}/jobs/claim`, { auth: workerKey, json: { waitSeconds: 20, types } });
    return r.status === 200 ? r.body : undefined;
  });
  made.jobs.add(c.jobId);
  const jobKey = unwrapJobKey(c.jobId, c.envelope, keys.privateKey);
  const params = JSON.parse(open(jobKey, b64u.dec(c.params), aad.params(c.jobId)).toString("utf8"));
  expect?.(params);
  let result = PNG;
  if (params.type === "face_swap") {
    const t = await call("GET", `${W}/jobs/${c.jobId}/inputs/${params.image}`, { auth: workerKey, lease: c.leaseId });
    result = open(jobKey, t.body, aad.input(c.jobId, params.image));
  }
  const up = await call("PUT", `${W}/jobs/${c.jobId}/results/1`, { auth: workerKey, lease: c.leaseId, bytes: seal(jobKey, result, aad.result(c.jobId, 1)) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await call("POST", `${W}/jobs/${c.jobId}/complete`, { auth: workerKey, json: { leaseId: c.leaseId, resultCount: 1 } })).status, 200);
  return { jobId: c.jobId, params };
}

test("setup: tokens and a live e2e worker", async () => {
  admin = await token("admin");
  alice = await token("alice");
  const w = await call("POST", `${API}/admin/workers`, { auth: admin, json: { name: "e2e features worker", mode: "test" } });
  assert.equal(w.status, 201);
  workerId = w.body.worker.id;
  workerKey = w.body.workerKey;
  const h = await call("POST", `${W}/hello`, { auth: workerKey, json: {
    protocol: "locke-worker/1", software: { name: "e2e-worker", version: "1" }, publicKey: b64u.enc(keys.publicKey),
    gpu: { name: "none", vramMb: 0 }, accepting: true, capabilities: CAPS } });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal((await call("PATCH", `${API}/admin/workers/${workerId}`, { auth: admin, json: { mode: "live" } })).status, 200);
});

test("characters: create, photos (metadata stripped), main face, isolation", async () => {
  const c = await call("POST", `${API}/characters`, { auth: alice, json: { name: "E2E kid", gender: "any", age: "child" } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  made.character = c.body.id;
  const f1 = await call("POST", `${API}/characters/${made.character}/faces`, { auth: alice, bytes: PNG, type: "image/png" });
  assert.equal(f1.status, 201, JSON.stringify(f1.body));
  const f2 = await call("POST", `${API}/characters/${made.character}/faces`, { auth: alice, bytes: PNG, type: "image/png" });
  assert.equal(f2.body.faces.length, 2);
  assert.equal((await call("POST", `${API}/characters/${made.character}/faces`, { auth: alice, bytes: Buffer.from("nope"), type: "image/png" })).status, 415);
  const [a, b] = f2.body.faces.map((f) => f.id);
  const re = await call("PATCH", `${API}/characters/${made.character}`, { auth: alice, json: { faceOrder: [b, a], name: "E2E child" } });
  assert.deepEqual(re.body.faces.map((f) => f.id), [b, a]);
  assert.equal(re.body.name, "E2E child");
  assert.equal(re.body.age, "child", "fields left out keep their value");
  const img = await call("GET", `${API}/characters/${made.character}/faces/${b}`, { auth: alice });
  assert.equal(img.status, 200);
  assert.deepEqual(img.body, PNG);
  assert.equal((await call("GET", `${API}/characters/${made.character}/faces/${b}`, { auth: admin })).status, 404, "not admin's");
  assert.equal((await call("GET", `${API}/characters`, { auth: admin })).body.characters.some((x) => x.id === made.character), false);
  assert.equal((await call("DELETE", `${API}/characters/${made.character}/faces/${a}`, { auth: alice })).body.faces.length, 1);
});

test("face swap with a saved character reaches only a worker that matches it", async () => {
  const form = new FormData();
  form.set("params", JSON.stringify({ type: "face_swap", image: "target", characters: [{ character: made.character }] }));
  form.set("target", new Blob([PNG], { type: "image/png" }), "t.png");
  const j = await call("POST", `${API}/jobs`, { auth: alice, form });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  made.jobs.add(j.body.id);
  const { params } = await workOne(["face_swap"], (p) => {
    assert.equal(p.characters[0].age, "child");
    assert.equal(p.characters[0].faces.length, 1);
    assert.ok(!JSON.stringify(p).includes("E2E"), "a character's name never reaches the worker");
  });
  assert.equal(params.type, "face_swap");
  assert.deepEqual((await call("GET", `${API}/jobs/${j.body.id}`, { auth: alice })).body.summary.names, ["E2E child"]);
});

test("saved prompt with a reference; a schedule runs it and keeps its results; Locke is a vault source", async () => {
  const form = new FormData();
  form.set("params", JSON.stringify({
    name: "E2E prompt", style: "e2e-style", aspect: "square", count: 1, mode: "fast", character: null,
    positive: [{ text: "a lighthouse", on: true }, { text: "fog", on: false }], negative: [{ text: "blurry", on: true }], references: ["r1"],
  }));
  form.set("r1", new Blob([PNG], { type: "image/png" }), "r1.png");
  const p = await call("POST", `${API}/prompts`, { auth: alice, form });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  made.prompt = p.body.id;
  assert.equal(p.body.positive[1].on, false, "switched-off fragments are kept");
  assert.equal((await call("GET", `${API}/prompts/${made.prompt}/references/${p.body.references[0].id}`, { auth: alice })).status, 200);
  assert.equal((await call("GET", `${API}/prompts`, { auth: admin })).body.prompts.some((x) => x.id === made.prompt), false);

  const bad = await call("PUT", `${API}/prompts/${made.prompt}/schedule`, { auth: alice, json: { spec: { repeat: "minutes", every: 2, tz: "UTC" } } });
  assert.equal(bad.status, 400);
  const s = await call("PUT", `${API}/prompts/${made.prompt}/schedule`, { auth: alice, json: { spec: { repeat: "minutes", every: 1, tz: "Europe/Brussels" }, active: true, keepResults: true } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const scheduleId = s.body.schedule.id;
  assert.ok(Date.parse(s.body.schedule.nextRunAt) - Date.now() <= 61_000);

  const { jobId } = await workOne(["generate"], (params) => {
    assert.deepEqual(params.positive, ["a lighthouse"], "only switched-on fragments run");
    assert.equal(params.references.length, 1);
  });
  const job = (await call("GET", `${API}/jobs/${jobId}`, { auth: alice })).body;
  assert.equal(job.scheduleId, scheduleId);
  assert.equal(job.kept, true);
  assert.equal(job.expiresAt, null, "kept results don't expire");
  // Stop further runs.
  await call("PUT", `${API}/prompts/${made.prompt}/schedule`, { auth: alice, json: { spec: { repeat: "minutes", every: 1, tz: "UTC" }, active: false, keepResults: true } });

  // Locke as a source, directly and through the vault (alice's own login).
  const info = await call("GET", `${API}/vault-source`, { auth: alice });
  assert.ok(info.body.collections.some((c) => c.id === scheduleId && c.name === "Scheduled · E2E prompt"));
  const q = await call("POST", `${API}/vault-source/query`, { auth: alice, json: { collection: scheduleId, limit: 10 } });
  assert.ok(q.body.items.some((i) => i.ref === `${jobId}.1`));
  assert.equal((await call("POST", `${API}/vault-source/query`, { auth: admin, json: { collection: scheduleId } })).body.items.length, 0);
  const sources = await call("GET", `${V}/sources`, { auth: alice });
  const locke = sources.body.sources.find((x) => x.id === "locke");
  assert.ok(locke?.available, `Locke listed as a vault source (VAULT_SOURCES): ${JSON.stringify(sources.body)}`);
  const content = await call("GET", `${V}/sources/locke/items/${encodeURIComponent(`${jobId}.1`)}/content`, { auth: alice });
  assert.equal(content.status, 200);
  assert.deepEqual(content.body, PNG);
  made.schedule = scheduleId;
});

test("automation: delegated key from Nevli; a workflow picks up a new image and adds face swap and upscale versions in the vault", async () => {
  const before = await call("GET", `${API}/automation`, { auth: alice });
  assert.equal(before.status, 200);
  const wf = await call("POST", `${API}/workflows`, { auth: alice, json: {
    name: "E2E workflow", sources: [{ source: "locke", collection: made.schedule, label: "E2E" }], steps: [{ op: "face_swap", characters: [made.character] }, { op: "upscale", scale: 2 }],
  } });
  assert.equal(wf.status, 201, JSON.stringify(wf.body));
  made.workflow = wf.body.id;
  if (!before.body.enabled) {
    assert.equal((await call("PATCH", `${API}/workflows/${made.workflow}`, { auth: alice, json: { active: true } })).body.error, "automation_required");
    const on = await call("POST", `${API}/automation`, { auth: alice });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    made.automation = true;
  }
  assert.equal((await call("GET", `${API}/automation`, { auth: alice })).body.working, true, "the key works at the vault");
  const dl = await call("GET", `${BASE}/nevli/api/me/delegations`, { auth: alice });
  const d = dl.body.find((x) => x.appId === "locke");
  assert.ok(d, JSON.stringify(dl.body));
  assert.deepEqual([...d.audience].sort(), ["dms", "locke", "locke-vault"]);

  const act = await call("PATCH", `${API}/workflows/${made.workflow}`, { auth: alice, json: { active: true } });
  assert.equal(act.body.active, true);
  // A new image arrives in the watched collection (the schedule's prompt, run by hand).
  await new Promise((r) => setTimeout(r, 1500));
  const run = await call("POST", `${API}/prompts/${made.prompt}/run`, { auth: alice });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  made.jobs.add(run.body.jobId);
  await workOne(["generate"]);

  // The engine stages it into the vault and queues the face swap (age "child": only the e2e worker matches).
  await workOne(["face_swap"], (p) => assert.equal(p.characters[0].age, "child"));
  // Then the upscale step, on the face-swapped version.
  await workOne(["upscale"], (p) => { assert.equal(p.scale, 2); assert.equal(p.output.format, "jpeg"); assert.ok(p.maxPixels > 0); });
  const done = await until("the workflow run to finish", async () => {
    const r = await call("GET", `${API}/workflows/${made.workflow}/runs`, { auth: alice });
    return r.body.runs.find((x) => x.status === "done" || x.status === "failed");
  });
  assert.equal(done.status, "done", JSON.stringify(done));
  made.items.add(done.itemId);
  const item = await call("GET", `${V}/items/${done.itemId}`, { auth: alice });
  assert.deepEqual(item.body.versions.map((v) => [v.app, v.operation]), [["vault", "import:locke"], ["locke", "face_swap"], ["locke", "upscale"]]);
  const w = (await call("GET", `${API}/workflows/${made.workflow}`, { auth: alice })).body;
  assert.equal(w.stats.done, 1);
  assert.equal(w.lastError, null);
});

test("Discord notifications: webhook checked, write-only, sealed; removable", async () => {
  const N = `${API}/notifications`;
  const adminBefore = (await call("GET", N, { auth: admin })).body; // the admin may have a real webhook: never touched
  assert.equal((await call("PUT", `${N}/discord`, { auth: alice, json: { webhookUrl: "https://evil.example/api/webhooks/1/x", appUrl: "https://x.example/apps/locke" } })).body.error, "invalid_webhook");
  // A well-formed but unknown webhook: saved, never returned, and Discord refuses the test.
  const fake = `https://discord.com/api/webhooks/100000000000000000/${"x".repeat(68)}`;
  const put = await call("PUT", `${N}/discord`, { auth: alice, json: { webhookUrl: fake, notifyFailures: false, appUrl: "https://x.example/apps/locke", lang: "fr" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.discord.configured, true);
  assert.ok(!JSON.stringify(put.body).includes("webhooks"), "the URL is write-only");
  const t = await call("POST", `${N}/discord/test`, { auth: alice });
  assert.equal(t.status, 502);
  assert.equal(t.body.error, "webhook_gone");
  assert.equal((await call("GET", N, { auth: alice })).body.discord.lastError, "webhook_gone");
  assert.deepEqual((await call("GET", N, { auth: admin })).body, adminBefore, "per user");
  assert.equal((await call("DELETE", `${N}/discord`, { auth: alice })).body.discord.configured, false);
});

test("assistant tools (MCP): listed for Nevli, need the user's key, act as the user with the app's own checks", async () => {
  const MCP = process.env.LOCKE_MCP_URL ?? "http://app-locke:8081/mcp";
  const rpc = async (method, params, key) => {
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()).result;
  };
  const tool = async (name, args, key) => {
    const r = await rpc("tools/call", { name, arguments: args }, key);
    return { error: r.isError ? r.content[0].text : null, body: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  const { tools } = await rpc("tools/list", {});
  const names = tools.map((x) => x.name).sort();
  for (const n of ["cancel_job", "delete_job", "face_swap", "generate_images", "get_job", "get_status", "list_characters", "list_jobs", "list_saved_prompts",
    "list_vault_photos", "list_workflows", "run_saved_prompt", "save_result_to_vault", "set_schedule_active", "set_workflow_active"]) assert.ok(names.includes(n), n);
  for (const n of ["cancel_job", "delete_job"]) assert.equal(tools.find((x) => x.name === n).annotations.destructiveHint, true, n);
  assert.match((await tool("list_jobs", {})).error, /API key/, "no key, no call");
  assert.ok((await tool("list_jobs", {}, "ilv_" + "a".repeat(43))).error, "unknown key refused");

  // Alice's own Ilven API key, as Ilven-AI gets it for her connex: only released while her preset allows a tool.
  const nevliAdmin = `${BASE}/nevli/api/admin`;
  const def = (await call("GET", `${nevliAdmin}/apps/locke/presets`, { auth: admin })).body.find((p) => p.isDefault);
  made.preset = { id: def.id, tools: def.tools };
  assert.equal((await call("PATCH", `${nevliAdmin}/presets/${def.id}`, { auth: admin, json: { tools: names } })).status, 200);
  const sub = JSON.parse(Buffer.from(alice.split(".")[1], "base64url").toString()).sub;
  const internalToken = readFileSync(`${process.env.SECRETS_DIR ?? "/s"}/internal/token`, "utf8").trim();
  const session = await fetch(`${process.env.NEVLI_INTERNAL_URL ?? "http://nevli:3001"}/internal/ai/session`, {
    method: "POST", headers: { "content-type": "application/json", "x-ilven-internal-token": internalToken }, body: JSON.stringify({ sub, appId: "locke" }),
  }).then((r) => r.json());
  if (session.status !== "ok") { console.log(`  (skipped the calls: assistant session is ${session.status})`); return; }
  const key = session.apiKey;

  const status = (await tool("get_status", {}, key)).body;
  assert.ok(status.generate.styles.some((x) => x.id === "e2e-style"));
  assert.ok((await tool("list_characters", {}, key)).body.characters.some((c) => c.id === made.character && c.photos === 1));
  assert.match((await tool("generate_images", { prompt: "x", style: "no-such-style" }, key)).error, /style|worker|GPU/i, "the app's own checks apply");

  // Generate → done → keep in the vault as a new photo.
  const g = await tool("generate_images", { prompt: "an e2e lighthouse", style: "e2e-style" }, key);
  assert.equal(g.error, null, g.error);
  made.jobs.add(g.body.id);
  assert.equal(g.body.status, "queued");
  const done = await workOne(["generate"], (p) => assert.deepEqual(p.positive, ["an e2e lighthouse"]));
  assert.equal(done.jobId, g.body.id);
  assert.equal((await tool("get_job", { id: g.body.id }, key)).body.status, "done");
  const kept = await tool("save_result_to_vault", { job: g.body.id }, key);
  assert.equal(kept.body.saved, "new_photo", kept.error);
  made.items.add(kept.body.photo);
  assert.ok((await tool("list_vault_photos", {}, key)).body.photos.some((p) => p.id === kept.body.photo));

  // Face swap that vault photo with a saved character → saving adds a version of the same photo.
  const fs = await tool("face_swap", { photo: kept.body.photo, characters: [made.character] }, key);
  assert.equal(fs.error, null, fs.error);
  made.jobs.add(fs.body.id);
  assert.equal(fs.body.vaultItem, kept.body.photo);
  await workOne(["face_swap"], (p) => assert.equal(p.characters[0].age, "child"));
  assert.equal((await tool("save_result_to_vault", { job: fs.body.id }, key)).body.saved, "new_version");
  assert.equal((await call("GET", `${V}/items/${kept.body.photo}`, { auth: alice })).body.versions.length, 2);

  // Other users' things don't exist for her key; destructive tools work on her own jobs.
  const theirs = await call("GET", `${API}/jobs?limit=1`, { auth: admin });
  if (theirs.body.jobs[0]) assert.match((await tool("get_job", { id: theirs.body.jobs[0].id }, key)).error, /not found/i);
  assert.equal((await tool("delete_job", { id: g.body.id }, key)).body.deleted, g.body.id);
  assert.ok(!(await tool("list_jobs", { limit: 50 }, key)).body.jobs.some((j) => j.id === g.body.id));
});

after(async () => {
  if (made.preset) await call("PATCH", `${BASE}/nevli/api/admin/presets/${made.preset.id}`, { auth: admin, json: { tools: made.preset.tools } });
});

after(async () => {
  if (!alice) return;
  if (made.workflow) {
    const runs = await call("GET", `${API}/workflows/${made.workflow}/runs`, { auth: alice });
    for (const r of runs.body?.runs ?? []) if (r.itemId) made.items.add(r.itemId);
    await call("DELETE", `${API}/workflows/${made.workflow}`, { auth: alice });
  }
  for (const id of made.items) await call("DELETE", `${V}/items/${id}`, { auth: alice });
  if (made.prompt) await call("DELETE", `${API}/prompts/${made.prompt}`, { auth: alice });
  if (made.character) await call("DELETE", `${API}/characters/${made.character}`, { auth: alice });
  if (made.automation) {
    await call("DELETE", `${API}/automation`, { auth: alice });
    const dl = await call("GET", `${BASE}/nevli/api/me/delegations`, { auth: alice });
    assert.ok(!dl.body.some((x) => x.appId === "locke"), "turning automation off revokes the key");
  }
  for (const id of made.jobs) {
    const j = await call("GET", `${API}/jobs/${id}`, { auth: alice });
    if (j.status === 200 && ["queued", "running"].includes(j.body.status)) await call("POST", `${API}/jobs/${id}/cancel`, { auth: alice });
    await call("DELETE", `${API}/jobs/${id}`, { auth: alice });
  }
  if (workerId) await call("DELETE", `${API}/admin/workers/${workerId}`, { auth: admin });
});
