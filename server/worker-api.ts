import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearer, hmacHex } from "@ilven/common";
import { aad, b64u, fingerprint, open } from "./crypto.ts";
import { detectFormat, imageSize, metadataBlocks } from "./images.ts";
import {
  claimOnce, err, FAIL_CODES, finishFailed, jobEvents, JOB_TYPES, jobKeyOf, leasedJob, queueSignal, reapLeases, renewLease, SETTINGS,
  supportsType, type Ctx, type WorkerRow,
} from "./jobs.ts";

/** Worker API `locke-worker/1` (docs/worker-api.md). Mounted under /apps/locke/api/worker/v1. */
export const WORKER_PREFIX = "/apps/locke/api/worker/v1";
const KEY_RE = /^lkw_[A-Za-z0-9_-]{43}$/;

export const workerKeyHash = (masterKey: string, key: string) => hmacHex(masterKey, "locke/worker-key", key);

const capabilitiesSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).optional(),
  resultFormats: z.array(z.string().max(10)).max(5).optional(),
  faceSwap: z.object({
    maxCharacters: z.number().int().min(1).max(8),
    maxFacesPerCharacter: z.number().int().min(1).max(8).optional(),
    genders: z.array(z.enum(["any", "woman", "man"])).min(1),
    ages: z.array(z.enum(["any", "child", "teen", "young", "adult", "senior"])).min(1),
    ageAliases: z.record(z.string(), z.string()).optional(),
    distinctFilters: z.boolean().optional(),
  }).nullable().optional(),
  generate: z.object({
    styles: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), label: z.string().max(80).optional() }).loose()).max(200).optional(),
    counts: z.array(z.number().int().min(1).max(4)).max(4).optional(),
    character: z.boolean().optional(),
  }).loose().nullable().optional(),
  enhance: z.object({}).loose().nullable().optional(),
  blur: z.object({}).loose().nullable().optional(),
  upscale: z.object({ scales: z.array(z.union([z.literal(2), z.literal(4)])).min(1).optional() }).loose().nullable().optional(),
  edit: z.unknown().optional(),
}).loose();

const helloSchema = z.object({
  protocol: z.string(),
  software: z.object({ name: z.string().max(60), version: z.string().max(40) }).optional(),
  publicKey: z.string().max(100),
  gpu: z.object({ name: z.string().max(100), vramMb: z.number().int().min(0).max(1e7) }).optional(),
  accepting: z.boolean().default(false),
  capabilities: capabilitiesSchema,
});

export function registerWorkerApi(app: FastifyInstance, ctx: Ctx, masterKey: string) {
  // Binary bodies (sealed results). Size is checked per route.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: SETTINGS.maxResultBytes + 1024 }, (_req, body, done) => done(null, body));

  // 120 requests per minute per worker key (§6), counted before any database work. Fixed one-minute windows.
  const windows = new Map<string, { start: number; count: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith(`${WORKER_PREFIX}/`)) return;
    const id = createHash("sha256").update(req.headers.authorization ?? `ip:${req.ip}`).digest("base64url");
    const now = Date.now();
    let win = windows.get(id);
    if (!win || now - win.start >= 60_000) {
      if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
      win = { start: now, count: 0 };
      windows.set(id, win);
    }
    if (++win.count > SETTINGS.rateLimitPerMinute) {
      const retry = Math.max(1, Math.ceil((win.start + 60_000 - now) / 1000));
      return reply.status(429).header("retry-after", String(retry)).send({ error: "rate_limited", message: `Too many requests, retry in ${retry} s` });
    }
  });

  async function authWorker(req: FastifyRequest, opts: { allowPending?: boolean; allowDisabled?: boolean } = {}): Promise<WorkerRow> {
    const key = bearer(req);
    if (!key || !KEY_RE.test(key)) throw err(401, "invalid_key", "Invalid worker key");
    const { rows } = await ctx.db.query<WorkerRow>(
      `UPDATE workers SET last_seen_at = now() WHERE key_hash = $1
       RETURNING id, name, mode, enabled, public_key, pending_public_key, capabilities, accepting, last_seen_at`,
      [workerKeyHash(masterKey, key)],
    );
    const w = rows[0];
    if (!w) throw err(401, "invalid_key", "Invalid worker key");
    if (!w.enabled && !opts.allowDisabled) throw err(403, "worker_disabled", "This worker is disabled in Locke");
    if (!opts.allowPending && w.pending_public_key) throw err(403, "key_pending", "Approve this worker's new key in Locke");
    return w;
  }

  const keyStatus = (w: { pending_public_key: Buffer | null }) => (w.pending_public_key ? "pending_approval" : "active");

  app.post(`${WORKER_PREFIX}/hello`, async (req) => {
    const w = await authWorker(req, { allowPending: true, allowDisabled: true });
    const b = helloSchema.parse(req.body);
    if (b.protocol !== "locke-worker/1") throw err(400, "unsupported_protocol", "Expected locke-worker/1");
    let pk: Buffer;
    try { pk = b64u.dec(b.publicKey); } catch { throw err(400, "invalid_public_key", "publicKey must be base64url"); }
    if (pk.length !== 32) throw err(400, "invalid_public_key", "publicKey must be 32 bytes");
    // The first key presented after a worker key is issued is trusted; any change then waits for an admin.
    const trusted = w.public_key ?? pk;
    const pending = trusted.equals(pk) ? null : pk;
    const { rows } = await ctx.db.query<WorkerRow & { mode: string }>(
      `UPDATE workers SET public_key = $2, pending_public_key = $3, capabilities = $4, software = $5, gpu = $6, accepting = $7,
         last_hello_at = now() WHERE id = $1 RETURNING id, mode, pending_public_key`,
      [w.id, trusted, pending, JSON.stringify(b.capabilities), JSON.stringify(b.software ?? null), JSON.stringify(b.gpu ?? null), b.accepting],
    );
    queueSignal.emit("job");
    return {
      workerId: w.id,
      keyStatus: keyStatus(rows[0]!),
      mode: rows[0]!.mode,
      fingerprint: fingerprint(pk),
      serverTime: new Date().toISOString(),
      settings: SETTINGS,
    };
  });

  app.post(`${WORKER_PREFIX}/heartbeat`, async (req) => {
    const w = await authWorker(req, { allowPending: true, allowDisabled: true });
    const { accepting } = z.object({ accepting: z.boolean() }).parse(req.body);
    await ctx.db.query("UPDATE workers SET accepting = $2 WHERE id = $1", [w.id, accepting]);
    const types = JOB_TYPES.filter((t) => supportsType(w.capabilities, t));
    const { rows } = await ctx.db.query<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM jobs WHERE status = 'queued' AND type = ANY($1)
         AND ((is_test AND target_worker = $2) OR (NOT is_test AND $3)) GROUP BY type`,
      [types, w.id, w.mode === "live" && w.enabled],
    );
    const queuedByType = Object.fromEntries(rows.map((r) => [r.type, r.n]));
    const queued = rows.reduce((sum, r) => sum + r.n, 0);
    return { keyStatus: keyStatus(w), queued, queuedByType, serverTime: new Date().toISOString() };
  });

  app.post(`${WORKER_PREFIX}/jobs/claim`, async (req, reply) => {
    const w = await authWorker(req);
    if (!w.public_key || !w.capabilities) throw err(409, "hello_required", "Call hello first");
    const b = z.object({ waitSeconds: z.number().min(0).max(SETTINGS.claimWaitMaxSeconds).default(0), types: z.array(z.string()).max(10).optional() })
      .parse(req.body ?? {});
    const types = JOB_TYPES.filter((t) => supportsType(w.capabilities, t) && (!b.types || b.types.includes(t)));
    await ctx.db.query("UPDATE workers SET accepting = true WHERE id = $1", [w.id]);
    const until = Date.now() + b.waitSeconds * 1000;
    let closed = false;
    req.raw.on("close", () => { closed = true; });
    for (;;) {
      await reapLeases(ctx);
      const job = await claimOnce(ctx, w, types);
      if (job) {
        if (closed) {
          // The worker went away while we were leasing: give the job back at once.
          await ctx.db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.jobId]);
          await reapLeases(ctx, job.jobId);
          return reply.status(204).send();
        }
        return job;
      }
      const left = until - Date.now();
      if (left <= 0 || closed) return reply.status(204).send();
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); queueSignal.off("job", done); resolve(); };
        const t = setTimeout(done, Math.min(left, 5000));
        queueSignal.on("job", done);
      });
    }
  });

  app.get(`${WORKER_PREFIX}/jobs/:jobId/inputs/:inputId`, async (req, reply) => {
    const w = await authWorker(req);
    const { jobId, inputId } = req.params as { jobId: string; inputId: string };
    await leasedJob(ctx, w, jobId, req.headers["x-locke-lease"]);
    const blob = /^[A-Za-z0-9_-]{1,64}$/.test(inputId) ? await ctx.store.get(`jobs/${jobId}/inputs/${inputId}`) : null;
    if (!blob) throw err(404, "input_not_found", "Unknown input");
    await renewLease(ctx, jobId);
    return reply.header("content-type", "application/octet-stream").header("cache-control", "no-store").send(blob);
  });

  app.post(`${WORKER_PREFIX}/jobs/:jobId/progress`, async (req) => {
    const w = await authWorker(req);
    const { jobId } = req.params as { jobId: string };
    const b = z.object({ leaseId: z.string(), progress: z.number().min(0).max(1).nullable().optional() }).parse(req.body);
    const j = await leasedJob(ctx, w, jobId, b.leaseId);
    const until = await renewLease(ctx, jobId);
    if (b.progress !== undefined) await ctx.db.query("UPDATE jobs SET progress = $2 WHERE id = $1", [jobId, b.progress]);
    return { leaseExpiresAt: until.toISOString(), cancel: j.cancel_requested };
  });

  app.put(`${WORKER_PREFIX}/jobs/:jobId/results/:n`, async (req) => {
    const w = await authWorker(req);
    const { jobId, n: nText } = req.params as { jobId: string; n: string };
    const j = await leasedJob(ctx, w, jobId, req.headers["x-locke-lease"]);
    const n = Number(nText);
    if (!/^[1-9][0-9]*$/.test(nText) || n > j.max_results) throw err(400, "invalid_result_number", `n must be 1…${j.max_results}`);
    const blob = req.body;
    if (!Buffer.isBuffer(blob)) throw err(415, "octet_stream_required", "Send the sealed result as application/octet-stream");
    if (blob.length > SETTINGS.maxResultBytes) throw err(413, "too_large", "Result too large");
    const key = jobKeyOf(ctx, j.job_key);
    let plain: Buffer;
    try {
      plain = open(key, blob, aad.result(jobId, n));
    } catch {
      throw err(422, "decrypt_failed", "The result does not decrypt with this job's key");
    } finally {
      key.fill(0);
    }
    const format = detectFormat(plain);
    if (!format) throw err(422, "unsupported_format", "Results must be PNG or JPEG");
    const meta = metadataBlocks(plain, format);
    const size = imageSize(plain, format);
    plain.fill(0);
    if (meta.length) throw err(422, "metadata_present", `Remove image metadata (${meta.join(", ")})`);
    const want = j.result_size;
    // Same size as the input, or rotated by 90° (an input JPEG's EXIF orientation applied to the pixels).
    if (want && (!size || !((size.width === want.width && size.height === want.height) || (size.width === want.height && size.height === want.width)))) {
      throw err(422, "wrong_size", `The result must be ${want.width}×${want.height} like the input`, { expected: want, got: size });
    }
    await ctx.store.put(`jobs/${jobId}/results/${n}`, blob);
    await ctx.db.query(
      "INSERT INTO job_results (job_id, n, bytes, format) VALUES ($1, $2, $3, $4) ON CONFLICT (job_id, n) DO UPDATE SET bytes = $3, format = $4",
      [jobId, n, blob.length, format],
    );
    await renewLease(ctx, jobId);
    return { n, bytes: blob.length };
  });

  app.post(`${WORKER_PREFIX}/jobs/:jobId/complete`, async (req) => {
    const w = await authWorker(req);
    const { jobId } = req.params as { jobId: string };
    const b = z.object({ leaseId: z.string(), resultCount: z.number().int().min(1).max(4) }).parse(req.body);
    // Idempotent: a repeated complete with the same lease succeeds.
    const done = await ctx.db.query("SELECT 1 FROM jobs WHERE id = $1 AND status = 'done' AND lease_id = $2 AND worker_id IS NOT DISTINCT FROM $3", [jobId, b.leaseId, w.id]);
    if (done.rowCount) return {};
    const j = await leasedJob(ctx, w, jobId, b.leaseId);
    if (b.resultCount > j.max_results) throw err(400, "invalid_result_count", `At most ${j.max_results} results`);
    const { rows } = await ctx.db.query<{ n: number }>("SELECT n FROM job_results WHERE job_id = $1", [jobId]);
    const have = new Set(rows.map((r) => r.n));
    for (let n = 1; n <= b.resultCount; n++) if (!have.has(n)) throw err(422, "missing_result", `Result ${n} was not uploaded`, { n });
    // Results beyond resultCount (an earlier upload) are dropped.
    for (const r of rows) if (r.n > b.resultCount) {
      await ctx.store.delete(`jobs/${jobId}/results/${r.n}`);
      await ctx.db.query("DELETE FROM job_results WHERE job_id = $1 AND n = $2", [jobId, r.n]);
    }
    await ctx.db.query(
      `UPDATE jobs SET status = 'done', result_count = $2, progress = 1, lease_expires_at = NULL, finished_at = now(),
         failure_code = NULL, expires_at = CASE WHEN keep THEN NULL ELSE now() + interval '7 days' END WHERE id = $1`,
      [jobId, b.resultCount],
    );
    jobEvents.emit("finished", jobId, "done");
    return {};
  });

  app.post(`${WORKER_PREFIX}/jobs/:jobId/fail`, async (req) => {
    const w = await authWorker(req);
    const { jobId } = req.params as { jobId: string };
    const b = z.object({
      leaseId: z.string(),
      code: z.enum(FAIL_CODES),
      retryable: z.boolean(),
      stage: z.enum(["params", "download", "engine", "upload"]).optional(),
    }).parse(req.body);
    await leasedJob(ctx, w, jobId, b.leaseId);
    req.log.info({ jobId, code: b.code, stage: b.stage, retryable: b.retryable }, "worker reported a failure");
    await finishFailed(ctx, jobId, b.code, b.retryable);
    return {};
  });
}
