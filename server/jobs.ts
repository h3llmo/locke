import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { HttpError, type Db, type Sealer } from "@ilven/common";
import { aad, b64u, open, seal, wrapJobKey } from "./crypto.ts";
import type { ObjectStore } from "./store.ts";

/** Values announced to workers in `hello` (docs/worker-api.md §3.1). */
export const SETTINGS = {
  claimWaitMaxSeconds: 30,
  heartbeatSeconds: 30,
  offlineAfterSeconds: 60,
  leaseSeconds: 60,
  progressIntervalSeconds: 15,
  maxConcurrency: 1,
  maxInputBytes: 25 * 1024 * 1024,
  maxResultBytes: 25 * 1024 * 1024,
  rateLimitPerMinute: 120,
  maxJobSeconds: { face_swap: 600, generate: 1800, enhance: 600, blur: 300, upscale: 900 } as Record<string, number>,
};
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_S = [30, 120] as const;
export const KEEP_UNKEPT_DAYS = 7;
export const JOB_TYPES = ["face_swap", "generate", "enhance", "blur", "upscale", "edit"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const GENDERS = ["any", "woman", "man"] as const;
export const AGES = ["any", "child", "teen", "young", "adult", "senior"] as const;
export const FAIL_CODES = ["unsupported", "invalid_input", "decrypt_failed", "no_face_found", "out_of_memory", "model_missing",
  "engine_unavailable", "timeout", "cancelled", "internal"] as const;

export interface Ctx { db: Db; store: ObjectStore; sealer: Sealer }

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const err = (status: number, code: string, message: string = code, extra?: Record<string, unknown>) =>
  Object.assign(new HttpError(status, code, message), { extra });

/** Wakes long-polling claims when a job becomes claimable. One Locke instance: an in-process signal is enough. */
export const queueSignal = new EventEmitter();
queueSignal.setMaxListeners(1000);
const signal = () => queueSignal.emit("job");
/** "finished" (jobId, "done" | "failed"): a job reached a final state with an outcome (notifications). */
export const jobEvents = new EventEmitter();

// ---------- capabilities and routing ----------

export interface FaceSwapRequirements { characters: { gender: string; age: string; faces: number }[]; format?: string }
export interface GenerateRequirements { style: string; count: number; references: number; character: boolean; format?: string }
/** Admin test jobs with hand-written params: routed on the job type only, so the worker's own validation is tested. */
export interface RawRequirements { raw: true }
export interface Capabilities {
  maxConcurrency?: number;
  resultFormats?: string[];
  faceSwap?: { maxCharacters?: number; maxFacesPerCharacter?: number; genders?: string[]; ages?: string[]; ageAliases?: Record<string, string>; distinctFilters?: boolean } | null;
  generate?: { styles?: { id: string; label?: string }[]; counts?: number[]; character?: boolean } | null;
  enhance?: unknown; blur?: unknown; upscale?: { scales?: number[] } | null; edit?: unknown;
}

const capKey: Record<JobType, keyof Capabilities> = { face_swap: "faceSwap", generate: "generate", enhance: "enhance", blur: "blur", upscale: "upscale", edit: "edit" };

export function supportsType(caps: Capabilities | null, type: string): boolean {
  if (!caps || type === "edit") return false;
  const v = caps[capKey[type as JobType]];
  return v !== null && v !== undefined;
}

/** Two characters could claim the same face (after the worker's age aliases). */
export function overlaps(a: { gender: string; age: string }, b: { gender: string; age: string }, aliases: Record<string, string> = {}) {
  const age = (x: string) => aliases[x] ?? x;
  const g = a.gender === b.gender || a.gender === "any" || b.gender === "any";
  const ag = age(a.age) === age(b.age) || a.age === "any" || b.age === "any";
  return g && ag;
}

/** Why a worker can't take a job, or null when it can. */
export function incompatibility(caps: Capabilities | null, type: string, req: unknown): "type" | "values" | "overlap" | null {
  if (!supportsType(caps, type)) return "type";
  if ((req as RawRequirements).raw) return null;
  const format = (req as { format?: string }).format ?? "png";
  if (!(caps!.resultFormats ?? ["png", "jpeg"]).includes(format)) return "values";
  if (type === "generate") {
    const g = caps!.generate!;
    const r = req as GenerateRequirements;
    if (!(g.styles ?? []).some((s) => s.id === r.style)) return "values";
    if (!(g.counts ?? [1]).includes(r.count)) return "values";
    if (r.references > 4) return "values";
    if (r.character && g.character === false) return "values";
    return null;
  }
  if (type === "upscale") return (caps!.upscale?.scales ?? [2]).includes((req as { scale: number }).scale) ? null : "values";
  if (type !== "face_swap") return null;
  const fs = caps!.faceSwap!;
  const chars = (req as FaceSwapRequirements).characters;
  if (chars.length > (fs.maxCharacters ?? 1)) return "values";
  for (const c of chars) {
    if (!(fs.genders ?? []).includes(c.gender) || !(fs.ages ?? []).includes(c.age)) return "values";
    if (c.faces > (fs.maxFacesPerCharacter ?? 8)) return "values";
  }
  if (fs.distinctFilters) {
    for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
      if (overlaps(chars[i]!, chars[j]!, fs.ageAliases)) return "overlap";
    }
  }
  return null;
}

/** Refuse at submit time what no live worker can do, with a message the user can act on. */
export async function assertSomeWorkerCan(ctx: Ctx, type: string, req: unknown) {
  const { rows } = await ctx.db.query<{ capabilities: Capabilities | null }>(
    "SELECT capabilities FROM workers WHERE enabled AND mode = 'live' AND public_key IS NOT NULL",
  );
  if (!rows.length) throw err(422, "no_worker", "No GPU worker is set up yet. An admin can add one in Settings → GPU workers.");
  const reasons = rows.map((r) => incompatibility(r.capabilities, type, req));
  if (reasons.includes(null)) return;
  if (reasons.includes("overlap")) throw err(422, "characters_overlap", "Give these characters different gender or age: the GPU worker can't tell them apart.");
  throw err(422, "unsupported", type === "face_swap"
    ? "No GPU worker supports this job (check the characters' gender and age)."
    : "No GPU worker supports these settings (style, number of results or references).");
}

// ---------- creating jobs ----------

export interface NewJob {
  ownerSub: string;
  type: JobType;
  params: Record<string, unknown>; // already uses the input ids below
  inputs: { id: string; data: Buffer }[];
  requirements: unknown;
  summary: Record<string, unknown>;
  maxResults: number;
  isTest?: boolean;
  targetWorker?: string;
  /** Results must have this pixel size (face_swap and blur keep the input's size). */
  resultSize?: { width: number; height: number } | null;
  /** Made by a schedule (Jobs › Scheduled, vault source collection). */
  scheduleId?: string | null;
  /** Results never expire (a schedule with "keep results"). */
  keep?: boolean;
  /** Step of an automated workflow run. */
  workflowRunId?: string | null;
}

export async function createJob(ctx: Ctx, j: NewJob): Promise<string> {
  const id = newId("job");
  const jobKey = randomBytes(32);
  const inputs: { id: string; bytes: number }[] = [];
  try {
    for (const input of j.inputs) {
      const sealed = seal(jobKey, input.data, aad.input(id, input.id));
      await ctx.store.put(`jobs/${id}/inputs/${input.id}`, sealed);
      inputs.push({ id: input.id, bytes: sealed.length });
    }
    const params = seal(jobKey, Buffer.from(JSON.stringify({ v: 1, type: j.type, ...j.params }), "utf8"), aad.params(id));
    await ctx.db.query(
      `INSERT INTO jobs (id, owner_sub, type, status, is_test, target_worker, requirements, job_key, params, summary, inputs, max_results, max_attempts, result_size,
         schedule_id, keep, workflow_run_id)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, j.ownerSub, j.type, !!j.isTest, j.targetWorker ?? null, JSON.stringify(j.requirements), ctx.sealer.seal(jobKey.toString("base64")),
        params, ctx.sealer.seal(JSON.stringify(j.summary)), JSON.stringify(inputs), j.maxResults, MAX_ATTEMPTS,
        j.resultSize ? JSON.stringify(j.resultSize) : null, j.scheduleId ?? null, !!j.keep, j.workflowRunId ?? null],
    );
  } catch (e) {
    await ctx.store.deletePrefix(`jobs/${id}/`).catch(() => {});
    throw e;
  } finally {
    jobKey.fill(0);
  }
  signal();
  return id;
}

export function jobKeyOf(ctx: Ctx, sealedKey: string | null): Buffer {
  if (!sealedKey) throw err(410, "expired", "This job's data was deleted");
  return Buffer.from(ctx.sealer.open(sealedKey), "base64");
}

/** Deletes everything readable about a job (inputs, results, params, key). The row stays for the history. */
export async function purgeJob(ctx: Ctx, id: string) {
  await ctx.store.deletePrefix(`jobs/${id}/`);
  await ctx.db.query("DELETE FROM job_results WHERE job_id = $1", [id]);
  await ctx.db.query("UPDATE jobs SET job_key = NULL, params = NULL WHERE id = $1", [id]);
}

// ---------- leases ----------

const finalExpiry = `now() + interval '${KEEP_UNKEPT_DAYS} days'`;

/** Expired leases: the worker vanished. Counts as an attempt; retried with back-off, cancelled, or failed. */
export async function reapLeases(ctx: Ctx, jobId?: string) {
  const { rows } = await ctx.db.query<{ id: string; status: string }>(
    `UPDATE jobs SET
       status = CASE WHEN cancel_requested THEN 'cancelled' WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
       failure_code = CASE WHEN cancel_requested THEN 'cancelled' WHEN attempt < max_attempts THEN failure_code ELSE 'lease_expired' END,
       not_before = now() + make_interval(secs => CASE WHEN attempt <= 1 THEN $2::int ELSE $3::int END),
       worker_id = NULL, lease_expires_at = NULL, progress = NULL,
       finished_at = CASE WHEN cancel_requested OR attempt >= max_attempts THEN now() ELSE NULL END,
       expires_at = CASE WHEN cancel_requested OR attempt >= max_attempts THEN ${finalExpiry} ELSE NULL END
     WHERE status = 'running' AND lease_expires_at < now() ${jobId ? "AND id = $1" : "AND $1::text IS NULL"}
     RETURNING id, status`,
    [jobId ?? null, RETRY_DELAYS_S[0], RETRY_DELAYS_S[1]],
  );
  for (const r of rows) {
    await ctx.db.query("DELETE FROM job_results WHERE job_id = $1", [r.id]);
    await ctx.store.deletePrefix(`jobs/${r.id}/results/`).catch(() => {});
    if (r.status === "cancelled") await purgeJob(ctx, r.id).catch(() => {});
    if (r.status === "failed") jobEvents.emit("finished", r.id, "failed");
    if (r.status === "queued") setTimeout(signal, RETRY_DELAYS_S[0] * 1000).unref();
  }
}

/** Past their keep date: data deleted, row kept as "expired". */
export async function expireJobs(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ id: string }>(
    "SELECT id FROM jobs WHERE expires_at < now() AND status IN ('done', 'failed', 'cancelled') LIMIT 200",
  );
  for (const r of rows) {
    await purgeJob(ctx, r.id);
    await ctx.db.query("UPDATE jobs SET status = 'expired' WHERE id = $1", [r.id]);
  }
}

export interface WorkerRow {
  id: string; name: string; mode: "test" | "live"; enabled: boolean; public_key: Buffer | null; pending_public_key: Buffer | null;
  capabilities: Capabilities | null; accepting: boolean; last_seen_at: Date | null;
}

/** Claims the oldest job this worker can take, or null. Leases it in the same transaction. */
export async function claimOnce(ctx: Ctx, w: WorkerRow, types: string[]) {
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    const running = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND worker_id = $1", [w.id]);
    const limit = Math.min(SETTINGS.maxConcurrency, w.capabilities?.maxConcurrency ?? 1);
    if (running.rows[0]!.n >= limit) throw err(409, "concurrency_limit", "This worker already holds a job");
    const { rows } = await c.query<{ id: string; type: string; requirements: unknown }>(
      `SELECT id, type, requirements FROM jobs
       WHERE status = 'queued' AND not_before <= now() AND type = ANY($1)
         AND ((is_test AND target_worker = $2) OR (NOT is_test AND $3))
       ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [types, w.id, w.mode === "live"],
    );
    const pick = rows.find((r) => incompatibility(w.capabilities, r.type, r.requirements) === null);
    if (!pick) {
      await c.query("COMMIT");
      return null;
    }
    const seconds = SETTINGS.maxJobSeconds[pick.type] ?? 600;
    const leased = await c.query(
      `UPDATE jobs SET status = 'running', attempt = attempt + 1, worker_id = $2, lease_id = $3,
         deadline_at = now() + make_interval(secs => $4::int),
         lease_expires_at = LEAST(now() + make_interval(secs => $5::int), now() + make_interval(secs => $4::int)),
         started_at = COALESCE(started_at, now()), progress = NULL
       WHERE id = $1
       RETURNING id, type, job_key, params, inputs, max_results, attempt, max_attempts, lease_id, lease_expires_at, deadline_at`,
      [pick.id, w.id, newId("lse"), seconds, SETTINGS.leaseSeconds],
    );
    await c.query("COMMIT");
    const j = leased.rows[0];
    const jobKey = jobKeyOf(ctx, j.job_key);
    try {
      return {
        jobId: j.id as string,
        leaseId: j.lease_id as string,
        leaseExpiresAt: (j.lease_expires_at as Date).toISOString(),
        deadlineAt: (j.deadline_at as Date).toISOString(),
        attempt: j.attempt as number,
        maxAttempts: j.max_attempts as number,
        type: j.type as string,
        envelope: wrapJobKey(j.id, jobKey, w.public_key!),
        params: b64u.enc(j.params as Buffer),
        inputs: j.inputs as { id: string; bytes: number }[],
        maxResults: j.max_results as number,
      };
    } finally {
      jobKey.fill(0);
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The job, if this worker holds this lease right now (renewing nothing). */
export async function leasedJob(ctx: Ctx, w: WorkerRow, jobId: string, leaseId: unknown) {
  await reapLeases(ctx, jobId);
  const { rows } = await ctx.db.query(
    "SELECT id, status, worker_id, lease_id, job_key, max_results, cancel_requested, deadline_at, result_size FROM jobs WHERE id = $1",
    [jobId],
  );
  const j = rows[0];
  if (!j) throw err(404, "job_not_found", "Unknown job");
  if (j.status !== "running" || j.worker_id !== w.id || typeof leaseId !== "string" || j.lease_id !== leaseId) {
    throw err(409, "lease_lost", "This worker no longer holds this job");
  }
  return j as {
    id: string; job_key: string; max_results: number; cancel_requested: boolean; deadline_at: Date;
    result_size: { width: number; height: number } | null;
  };
}

export async function renewLease(ctx: Ctx, jobId: string): Promise<Date> {
  const { rows } = await ctx.db.query<{ lease_expires_at: Date }>(
    `UPDATE jobs SET lease_expires_at = LEAST(now() + make_interval(secs => $2::int), deadline_at) WHERE id = $1 RETURNING lease_expires_at`,
    [jobId, SETTINGS.leaseSeconds],
  );
  return rows[0]!.lease_expires_at;
}

export async function finishFailed(ctx: Ctx, jobId: string, code: string, retryable: boolean) {
  const { rows } = await ctx.db.query<{ status: string; attempt: number }>(
    `UPDATE jobs SET
       status = CASE WHEN cancel_requested OR $2 = 'cancelled' THEN 'cancelled'
                     WHEN $3 AND attempt < max_attempts THEN 'queued' ELSE 'failed' END,
       failure_code = $2,
       not_before = now() + make_interval(secs => CASE WHEN attempt <= 1 THEN $4::int ELSE $5::int END),
       worker_id = NULL, lease_expires_at = NULL, progress = NULL,
       finished_at = CASE WHEN $3 AND attempt < max_attempts AND NOT cancel_requested AND $2 <> 'cancelled' THEN NULL ELSE now() END,
       expires_at = CASE WHEN $3 AND attempt < max_attempts AND NOT cancel_requested AND $2 <> 'cancelled' THEN NULL ELSE ${finalExpiry} END
     WHERE id = $1 RETURNING status, attempt`,
    [jobId, code, retryable, RETRY_DELAYS_S[0], RETRY_DELAYS_S[1]],
  );
  await ctx.db.query("DELETE FROM job_results WHERE job_id = $1", [jobId]);
  await ctx.store.deletePrefix(`jobs/${jobId}/results/`);
  const status = rows[0]!.status;
  if (status === "cancelled") await purgeJob(ctx, jobId);
  if (status === "failed") jobEvents.emit("finished", jobId, "failed");
  if (status === "queued") setTimeout(signal, (rows[0]!.attempt <= 1 ? RETRY_DELAYS_S[0]! : RETRY_DELAYS_S[1]!) * 1000 + 100).unref();
  return status;
}

// ---------- reading results (users) ----------

export async function readResult(ctx: Ctx, jobId: string, n: number, sealedKey: string | null): Promise<Buffer> {
  const blob = await ctx.store.get(`jobs/${jobId}/results/${n}`);
  if (!blob) throw err(404, "not_found", "Result not found");
  const key = jobKeyOf(ctx, sealedKey);
  try {
    return open(key, blob, aad.result(jobId, n));
  } finally {
    key.fill(0);
  }
}
