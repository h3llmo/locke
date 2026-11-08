import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createCallerAuthenticator, type Caller } from "@ilven/common";
import { fingerprint } from "./crypto.ts";
import { contentType, detectFormat, stripMetadata, syntheticPng } from "./images.ts";
import {
  AGES, assertSomeWorkerCan, createJob, err, GENDERS, incompatibility, newId, purgeJob, readResult, SETTINGS, type Capabilities, type Ctx,
} from "./jobs.ts";
import { workerKeyHash } from "./worker-api.ts";

export const API_PREFIX = "/apps/locke/api";
const MAX_CHARACTERS = 4;
const MAX_FACES = 8;

/** The app's own API (used by Locke's web app; Ilven-AI later calls the same checks through MCP). */
export function registerApi(app: FastifyInstance, ctx: Ctx, masterKey: string) {
  const authenticate = createCallerAuthenticator({ allowApiKey: true });
  const admin = async (req: FastifyRequest): Promise<Caller> => {
    const c = await authenticate(req);
    if (c.kind !== "identity" || !c.isAdmin) throw err(403, "forbidden", "Locke admins only");
    return c;
  };

  app.get(`${API_PREFIX}/me`, async (req) => {
    const c = await authenticate(req);
    return { isAdmin: c.kind === "identity" && c.isAdmin };
  });

  // ---------- GPU status, as users see it ----------
  app.get(`${API_PREFIX}/worker-status`, async (req) => {
    const c = await authenticate(req);
    const { rows } = await ctx.db.query<{ online: boolean; accepting: boolean; busy: boolean }>(
      `SELECT w.last_seen_at > now() - make_interval(secs => $1::int) AS online, w.accepting,
              EXISTS (SELECT 1 FROM jobs j WHERE j.worker_id = w.id AND j.status = 'running') AS busy
       FROM workers w WHERE w.enabled AND w.mode = 'live' AND w.public_key IS NOT NULL`,
      [SETTINGS.offlineAfterSeconds],
    );
    const status = rows.some((r) => r.online && r.busy) ? "busy" : rows.some((r) => r.online && r.accepting) ? "online"
      : rows.some((r) => r.online) ? "paused" : "offline";
    const mine = await ctx.db.query<{ queued: number; running: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running
       FROM jobs WHERE owner_sub = $1 AND NOT is_test`,
      [c.sub],
    );
    return { status, workers: rows.length, ...mine.rows[0] };
  });

  // ---------- jobs ----------
  const charSchema = z.object({
    gender: z.enum(GENDERS),
    age: z.enum(AGES),
    faces: z.array(z.string().min(1).max(64)).min(1).max(MAX_FACES),
    mainFace: z.string().min(1).max(64),
  }).refine((c) => c.faces.includes(c.mainFace), { message: "mainFace must be one of faces" });
  const faceSwapSchema = z.object({
    type: z.literal("face_swap"),
    image: z.string().min(1).max(64),
    characters: z.array(charSchema).min(1).max(MAX_CHARACTERS),
    output: z.object({ format: z.enum(["png", "jpeg"]) }).optional(),
  });

  /**
   * Multipart: a `params` field (JSON) and one file per image; params refer to the files by their field names.
   * Images are checked (PNG or JPEG), stripped of metadata, then sealed with the job's key before storage.
   */
  app.post(`${API_PREFIX}/jobs`, async (req, reply) => {
    const c = await authenticate(req);
    if (!req.isMultipart()) throw err(415, "multipart_required", "Send the job as multipart/form-data");
    let paramsText: string | undefined;
    const files = new Map<string, Buffer>();
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (files.has(part.fieldname)) throw err(400, "bad_request", `Duplicate file ${part.fieldname}`);
        files.set(part.fieldname, await part.toBuffer());
      } else if (part.fieldname === "params") {
        paramsText = String(part.value);
      }
    }
    if (!paramsText) throw err(400, "bad_request", "Missing params");
    let raw: unknown;
    try { raw = JSON.parse(paramsText); } catch { throw err(400, "bad_request", "params is not JSON"); }
    const p = faceSwapSchema.parse(raw);
    const requirements = { characters: p.characters.map((ch) => ({ gender: ch.gender, age: ch.age, faces: ch.faces.length })), format: p.output?.format ?? "png" };
    await assertSomeWorkerCan(ctx, p.type, requirements);

    const inputs: { id: string; data: Buffer }[] = [];
    const used = new Map<string, string>();
    const input = (field: string) => {
      const existing = used.get(field);
      if (existing) return existing;
      const data = files.get(field);
      if (!data) throw err(400, "bad_request", `Missing file ${field}`);
      const format = detectFormat(data);
      if (!format) throw err(415, "unsupported_image", `${field}: use a PNG or JPEG image`);
      const id = newId("in");
      inputs.push({ id, data: stripMetadata(data, format) });
      used.set(field, id);
      return id;
    };
    const params = {
      image: input(p.image),
      match: "largest",
      characters: p.characters.map((ch, i) => ({
        ref: `ch_${i + 1}`,
        faces: ch.faces.map(input),
        mainFace: input(ch.mainFace),
        gender: ch.gender,
        age: ch.age,
      })),
      output: p.output ?? { format: "png" },
    };
    if (used.size !== files.size) throw err(400, "bad_request", "Every uploaded file must be used by params");
    const id = await createJob(ctx, {
      ownerSub: c.sub, type: "face_swap", params, inputs, requirements, maxResults: 1,
      summary: { title: "Face swap", characters: p.characters.length },
    });
    return reply.status(201).send(await jobView(id, c.sub));
  });

  async function jobView(id: string, ownerSub: string) {
    const { rows } = await ctx.db.query(
      `SELECT j.*, (SELECT count(*)::int FROM jobs q WHERE q.status = 'queued' AND NOT q.is_test AND q.created_at <= j.created_at) AS position
       FROM jobs j WHERE j.id = $1 AND j.owner_sub = $2`,
      [id, ownerSub],
    );
    const j = rows[0];
    if (!j) throw err(404, "not_found", "Job not found");
    return toView(j);
  }

  function toView(j: Record<string, unknown>) {
    let summary: unknown = null;
    try { summary = j.summary ? JSON.parse(ctx.sealer.open(j.summary as string)) : null; } catch { summary = null; }
    return {
      id: j.id,
      type: j.type,
      status: j.status,
      test: j.is_test,
      summary,
      progress: j.progress,
      attempt: j.attempt,
      queuePosition: j.status === "queued" ? j.position : null,
      failureCode: j.failure_code,
      resultCount: j.result_count,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
      expiresAt: j.expires_at,
      cancelRequested: j.cancel_requested,
    };
  }

  app.get(`${API_PREFIX}/jobs`, async (req) => {
    const c = await authenticate(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.iso.datetime().optional() }).parse(req.query);
    const { rows } = await ctx.db.query(
      `SELECT j.*, (SELECT count(*)::int FROM jobs q WHERE q.status = 'queued' AND NOT q.is_test AND q.created_at <= j.created_at) AS position
       FROM jobs j WHERE j.owner_sub = $1 AND ($2::timestamptz IS NULL OR j.created_at < $2)
       ORDER BY j.created_at DESC LIMIT $3`,
      [c.sub, q.before ?? null, q.limit],
    );
    return { jobs: rows.map(toView) };
  });

  app.get(`${API_PREFIX}/jobs/:id`, async (req) => {
    const c = await authenticate(req);
    return jobView((req.params as { id: string }).id, c.sub);
  });

  app.get(`${API_PREFIX}/jobs/:id/results/:n`, async (req, reply) => {
    const c = await authenticate(req);
    const { id, n } = req.params as { id: string; n: string };
    const { rows } = await ctx.db.query<{ job_key: string | null; format: string }>(
      `SELECT j.job_key, r.format FROM jobs j JOIN job_results r ON r.job_id = j.id
       WHERE j.id = $1 AND j.owner_sub = $2 AND j.status = 'done' AND r.n = $3`,
      [id, c.sub, Number(n) || 0],
    );
    if (!rows[0]) throw err(404, "not_found", "Result not found");
    const image = await readResult(ctx, id, Number(n), rows[0].job_key);
    return reply.header("content-type", contentType(rows[0].format as "png" | "jpeg")).header("cache-control", "private, no-store").send(image);
  });

  app.post(`${API_PREFIX}/jobs/:id/cancel`, async (req) => {
    const c = await authenticate(req);
    const { id } = req.params as { id: string };
    const { rows } = await ctx.db.query<{ status: string }>(
      `UPDATE jobs SET
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         cancel_requested = (status = 'running'),
         failure_code = CASE WHEN status = 'queued' THEN 'cancelled' ELSE failure_code END,
         finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
         expires_at = CASE WHEN status = 'queued' THEN now() + interval '7 days' ELSE expires_at END
       WHERE id = $1 AND owner_sub = $2 AND status IN ('queued', 'running') RETURNING status`,
      [id, c.sub],
    );
    if (!rows[0]) throw err(409, "conflict", "Only queued or running jobs can be cancelled");
    if (rows[0].status === "cancelled") await purgeJob(ctx, id);
    return jobView(id, c.sub);
  });

  app.delete(`${API_PREFIX}/jobs/:id`, async (req, reply) => {
    const c = await authenticate(req);
    const { id } = req.params as { id: string };
    const { rows } = await ctx.db.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1 AND owner_sub = $2", [id, c.sub]);
    if (!rows[0]) throw err(404, "not_found", "Job not found");
    if (rows[0].status === "running" || rows[0].status === "queued") throw err(409, "conflict", "Cancel the job first");
    await purgeJob(ctx, id);
    await ctx.db.query("DELETE FROM jobs WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  // ---------- GPU workers (admins) ----------
  const workerView = (w: Record<string, unknown>) => {
    const online = !!w.last_seen_at && Date.now() - (w.last_seen_at as Date).getTime() < SETTINGS.offlineAfterSeconds * 1000;
    return {
      id: w.id,
      name: w.name,
      mode: w.mode,
      enabled: w.enabled,
      keyStatus: w.pending_public_key ? "pending_approval" : w.public_key ? "active" : "waiting_for_worker",
      fingerprint: w.public_key ? fingerprint(w.public_key as Buffer) : null,
      pendingFingerprint: w.pending_public_key ? fingerprint(w.pending_public_key as Buffer) : null,
      state: !online ? "offline" : w.busy ? "busy" : w.accepting ? "online" : "paused",
      software: w.software,
      gpu: w.gpu,
      capabilities: w.capabilities,
      lastSeenAt: w.last_seen_at,
      keyIssuedAt: w.key_issued_at,
      createdAt: w.created_at,
    };
  };
  const workerSql = `SELECT w.*, EXISTS (SELECT 1 FROM jobs j WHERE j.worker_id = w.id AND j.status = 'running') AS busy FROM workers w`;
  const getWorker = async (id: string) => {
    const { rows } = await ctx.db.query(`${workerSql} WHERE w.id = $1`, [id]);
    if (!rows[0]) throw err(404, "not_found", "Worker not found");
    return rows[0] as Record<string, unknown>;
  };
  const newKey = () => `lkw_${randomBytes(32).toString("base64url")}`;

  app.get(`${API_PREFIX}/admin/workers`, async (req) => {
    await admin(req);
    const { rows } = await ctx.db.query(`${workerSql} ORDER BY w.created_at`);
    return { workers: rows.map(workerView) };
  });

  // The key is shown once. The worker's first hello then registers its public key.
  app.post(`${API_PREFIX}/admin/workers`, async (req, reply) => {
    await admin(req);
    const b = z.object({ name: z.string().trim().min(1).max(60), mode: z.enum(["test", "live"]).default("test") }).parse(req.body);
    const id = newId("wrk");
    const key = newKey();
    await ctx.db.query("INSERT INTO workers (id, name, key_hash, mode) VALUES ($1, $2, $3, $4)", [id, b.name, workerKeyHash(masterKey, key), b.mode]);
    return reply.status(201).send({ worker: workerView(await getWorker(id)), workerKey: key });
  });

  app.patch(`${API_PREFIX}/admin/workers/:id`, async (req) => {
    await admin(req);
    const { id } = req.params as { id: string };
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), mode: z.enum(["test", "live"]).optional(), enabled: z.boolean().optional() }).parse(req.body);
    await getWorker(id);
    await ctx.db.query(
      "UPDATE workers SET name = COALESCE($2, name), mode = COALESCE($3, mode), enabled = COALESCE($4, enabled) WHERE id = $1",
      [id, b.name ?? null, b.mode ?? null, b.enabled ?? null],
    );
    return { worker: workerView(await getWorker(id)) };
  });

  // New key: the old one stops working at once; the worker's next hello registers its (new) public key.
  app.post(`${API_PREFIX}/admin/workers/:id/rotate-key`, async (req) => {
    await admin(req);
    const { id } = req.params as { id: string };
    await getWorker(id);
    const key = newKey();
    await ctx.db.query(
      "UPDATE workers SET key_hash = $2, public_key = NULL, pending_public_key = NULL, key_issued_at = now() WHERE id = $1",
      [id, workerKeyHash(masterKey, key)],
    );
    return { worker: workerView(await getWorker(id)), workerKey: key };
  });

  app.post(`${API_PREFIX}/admin/workers/:id/approve-key`, async (req) => {
    await admin(req);
    const { id } = req.params as { id: string };
    const b = z.object({ fingerprint: z.string() }).parse(req.body);
    const w = await getWorker(id);
    if (!w.pending_public_key) throw err(409, "conflict", "No key waiting for approval");
    if (fingerprint(w.pending_public_key as Buffer) !== b.fingerprint) throw err(409, "conflict", "The waiting key changed; check the fingerprint again");
    await ctx.db.query("UPDATE workers SET public_key = pending_public_key, pending_public_key = NULL WHERE id = $1", [id]);
    return { worker: workerView(await getWorker(id)) };
  });

  app.delete(`${API_PREFIX}/admin/workers/:id`, async (req, reply) => {
    await admin(req);
    const { id } = req.params as { id: string };
    await getWorker(id);
    // Its running jobs go back to the queue (or fail after their last attempt) when their lease runs out.
    await ctx.db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE worker_id = $1 AND status = 'running'", [id]);
    const tests = await ctx.db.query<{ id: string }>("SELECT id FROM jobs WHERE target_worker = $1", [id]);
    for (const t of tests.rows) await purgeJob(ctx, t.id);
    await ctx.db.query("DELETE FROM workers WHERE id = $1", [id]);
    return reply.status(204).send();
  });

  /**
   * Test jobs, sent only to this worker (admins). Inputs are synthetic images (no real face).
   * - face_swap: expected outcome done, or failed with no_face_found; both prove the whole path.
   * - generate: the default parameters below, overridden by `params` (validated against the worker's capabilities),
   *   with `references` synthetic reference images.
   * - `raw: true`: `params` are sent as written, without validation (to test the worker's own refusals).
   */
  app.post(`${API_PREFIX}/admin/workers/:id/test-job`, async (req, reply) => {
    const c = await admin(req);
    const { id } = req.params as { id: string };
    const b = z.object({
      type: z.enum(["face_swap", "generate"]).default("face_swap"),
      params: z.record(z.string(), z.unknown()).default({}),
      references: z.number().int().min(0).max(4).default(0),
      raw: z.boolean().default(false),
    }).parse(req.body ?? {});
    const w = await getWorker(id);
    const caps = w.capabilities as Capabilities | null;
    if (!caps) throw err(409, "conflict", "This worker hasn't connected yet (no hello)");
    const summary = { title: b.type === "generate" ? "Generate test" : "Face swap test", worker: w.name };

    if (b.type === "face_swap") {
      const fs = caps.faceSwap;
      if (!fs) throw err(409, "conflict", "This worker doesn't announce face swap");
      const pick = (list: string[] | undefined) => (list?.includes("any") ? "any" : list?.[0] ?? "any");
      const target = { id: newId("in"), data: syntheticPng(512, 512, 1) };
      const face = { id: newId("in"), data: syntheticPng(256, 256, 2) };
      const character = { gender: pick(fs.genders), age: pick(fs.ages) };
      const jobId = await createJob(ctx, {
        ownerSub: c.sub, type: "face_swap", isTest: true, targetWorker: id, maxResults: 1, inputs: [target, face], summary,
        requirements: b.raw ? { raw: true } : { characters: [{ ...character, faces: 1 }] },
        params: { test: true, image: target.id, match: "largest", characters: [{ ref: "ch_1", faces: [face.id], mainFace: face.id, ...character }], output: { format: "png" }, ...b.params },
      });
      return reply.status(201).send(await jobView(jobId, c.sub));
    }

    if (!caps.generate) throw err(409, "conflict", "This worker doesn't announce generate");
    const refs = Array.from({ length: b.references }, (_, i) => ({ id: newId("in"), data: syntheticPng(512, 512, i + 3) }));
    const params: Record<string, unknown> = {
      test: true,
      positive: ["a red apple on a wooden table", "studio photo"],
      negative: ["blurry"],
      style: caps.generate.styles?.some((s) => s.id === "photo-neutre") ? "photo-neutre" : caps.generate.styles?.[0]?.id,
      aspect: "portrait",
      count: 1,
      mode: "fast",
      references: refs.map((r) => r.id),
      seed: 12345,
      output: { format: "png" },
      ...b.params,
    };
    const count = Number(params.count);
    const maxResults = Number.isInteger(count) ? Math.min(4, Math.max(1, count)) : 1;
    if (!b.raw) {
      z.object({
        positive: z.array(z.string().max(500)).max(50),
        negative: z.array(z.string().max(500)).max(50),
        style: z.string(),
        aspect: z.enum(["square", "portrait", "landscape"]),
        count: z.number().int().min(1).max(4),
        mode: z.enum(["fast", "quality"]),
        seed: z.number().int().min(0).max(2 ** 32 - 1).nullable(),
        output: z.object({ format: z.enum(["png", "jpeg"]) }),
      }).loose().parse(params);
      if (params.character !== undefined) throw err(422, "unsupported", "Characters in generate test jobs need raw: true");
    }
    const requirements = b.raw ? { raw: true } : {
      style: params.style, count, references: refs.length, character: params.character !== undefined,
      format: (params.output as { format: string }).format,
    };
    if (!b.raw) {
      const why = incompatibility(caps, "generate", requirements);
      if (why) throw err(422, "unsupported", "This worker can't run these parameters (style, count or format)");
    }
    const jobId = await createJob(ctx, { ownerSub: c.sub, type: "generate", isTest: true, targetWorker: id, maxResults, inputs: refs, summary, requirements, params });
    return reply.status(201).send(await jobView(jobId, c.sub));
  });
}
