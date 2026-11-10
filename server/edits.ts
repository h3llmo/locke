import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "@ilven/common";
import { KEEP_UNKEPT_DAYS, err, newId, purgeJob, readResult, type Ctx } from "./jobs.ts";
import { cleanImage, readMultipart } from "./builders.ts";
import { contentType, detectFormat, imageSize } from "./images.ts";
import { RowBlobs, newBlobKey, openRow, sealRow } from "./sealed.ts";
import { MAX_STEPS, checkSteps, skippable, startStep, stepSchema, stepTitle, type Step } from "./steps.ts";
import { notifier } from "./notify.ts";

/**
 * Edits (Editor): several tools on one photo, in the user's order (e.g. upscale ×2 then blur), handled as one thing.
 * Each step is a GPU job, hidden from the job list; its result becomes the input of the next step. Only the final
 * result is offered: keeping it on a vault photo adds one version. A step that finds no face (face swap, enhance) is
 * skipped and noted.
 *
 * The original and the working image are sealed in the object store under a per-edit key (RowBlobs). Steps run while
 * the user is away (Locke holds the images itself, no vault access needed). Unkept results are deleted after
 * KEEP_UNKEPT_DAYS, like job results.
 */
const MAX_RUNNING_PER_USER = 20;

interface EditData { steps: Step[]; vaultItem?: string; vaultVersion?: number }
interface EditRow {
  id: string; owner_sub: string; data: string; blob_key: string; status: "running" | "done" | "failed" | "cancelled";
  step: number; job_id: string | null; notes: string[]; failure: string | null;
  result: { format: string; width: number; height: number; bytes: number } | null;
  created_at: Date; updated_at: Date; finished_at: Date | null; expires_at: Date | null;
}
type Joined = EditRow & { job_status: string | null; job_failure: string | null; job_key: string | null; job_progress: number | null; position: number | null };

const blobsOf = (ctx: Ctx) => new RowBlobs(ctx.store, ctx.sealer, "edits");
const finalExpiry = `now() + interval '${KEEP_UNKEPT_DAYS} days'`;

/** Vault operation name for a kept edit: the steps' names ("upscale-blur"), or "edit" when too long. */
export const editOperation = (steps: Step[]) => {
  const op = steps.map((s) => s.op).join("-");
  return op.length <= 41 ? op : "edit";
};

const SELECT = `SELECT e.*, j.status AS job_status, j.failure_code AS job_failure, j.job_key, j.progress AS job_progress,
  CASE WHEN j.status = 'queued' THEN (SELECT count(*)::int FROM jobs q WHERE q.status = 'queued' AND NOT q.is_test AND q.created_at <= j.created_at) END AS position
  FROM edits e LEFT JOIN jobs j ON j.id = e.job_id`;

function view(ctx: Ctx, e: Joined) {
  const d = openRow<EditData>(ctx.sealer, e.id, e.data);
  return {
    id: e.id, status: e.status, steps: d.steps, step: e.step, notes: e.notes, failure: e.failure,
    vaultItem: d.vaultItem ?? null, vaultVersion: d.vaultVersion ?? null, operation: editOperation(d.steps),
    current: e.status === "running" && e.job_status
      ? { status: e.job_status, progress: e.job_progress, queuePosition: e.position }
      : null,
    result: e.status === "done" ? e.result : null,
    createdAt: e.created_at, updatedAt: e.updated_at, finishedAt: e.finished_at, expiresAt: e.expires_at,
  };
}
export type EditView = ReturnType<typeof view>;

/** Removes a step's job entirely (its image now lives in the edit). */
async function dropJob(ctx: Ctx, jobId: string) {
  await purgeJob(ctx, jobId);
  await ctx.db.query("DELETE FROM jobs WHERE id = $1", [jobId]);
}

/** Stops an edit's current job: a queued one is cancelled at once, a running one is told to stop. */
async function stopJob(ctx: Ctx, jobId: string | null) {
  if (!jobId) return;
  const { rows } = await ctx.db.query<{ id: string }>(
    `UPDATE jobs SET status = 'cancelled', failure_code = 'cancelled', finished_at = now(), expires_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id`,
    [jobId],
  );
  if (rows[0]) await purgeJob(ctx, jobId).catch(() => {});
  else await ctx.db.query("UPDATE jobs SET cancel_requested = true WHERE id = $1 AND status = 'running'", [jobId]);
}

export function registerEditsApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: (req: FastifyRequest) => Promise<{ sub: string }>) {
  const blobs = blobsOf(ctx);
  const one = async (sub: string, id: string) => {
    const { rows } = await ctx.db.query<Joined>(`${SELECT} WHERE e.id = $1 AND e.owner_sub = $2`, [id, sub]);
    if (!rows[0]) throw err(404, "not_found", "Edit not found");
    return rows[0];
  };
  const idOf = (p: unknown) => z.object({ id: z.string().max(64) }).parse(p).id;

  /** Multipart: `params` {image, steps, vaultItem?, vaultVersion?} and the photo. Every step is checked up front. */
  app.post(`${prefix}/edits`, async (req, reply) => {
    const c = await auth(req);
    const { params, files } = await readMultipart(req);
    const p = z.object({
      image: z.string().min(1).max(64),
      steps: z.array(stepSchema).min(1).max(MAX_STEPS),
      vaultItem: z.uuid().optional(),
      vaultVersion: z.number().int().min(1).optional(),
    }).parse(params);
    const photo = files.get(p.image);
    if (!photo || files.size !== 1) throw err(400, "bad_request", "Send exactly one photo, named by params.image");
    const clean = cleanImage("photo", photo);
    if (!clean.size) throw err(415, "unsupported_image", "photo: unreadable image size");
    await checkSteps(ctx, c.sub, p.steps);
    const { rows: n } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM edits WHERE owner_sub = $1 AND status = 'running'", [c.sub]);
    if (n[0]!.n >= MAX_RUNNING_PER_USER) throw err(409, "too_many", `At most ${MAX_RUNNING_PER_USER} edits in progress`);

    const id = newId("ed");
    const key = newBlobKey(ctx.sealer);
    const data: EditData = { steps: p.steps, ...(p.vaultItem ? { vaultItem: p.vaultItem } : {}), ...(p.vaultVersion ? { vaultVersion: p.vaultVersion } : {}) };
    try {
      await blobs.put(id, key, "original", clean.data);
      await blobs.put(id, key, "current", clean.data);
      await ctx.db.query("INSERT INTO edits (id, owner_sub, data, blob_key, status) VALUES ($1, $2, $3, $4, 'running')", [id, c.sub, sealRow(ctx.sealer, id, data), key]);
      const jobId = await startStep(ctx, c.sub, p.steps[0]!, clean.data, { editId: id, summary: { title: `Edit · ${stepTitle(p.steps[0]!)}` } });
      await ctx.db.query("UPDATE edits SET job_id = $2 WHERE id = $1", [id, jobId]);
    } catch (e) {
      await ctx.db.query("DELETE FROM edits WHERE id = $1", [id]).catch(() => {});
      await blobs.deleteRow(id).catch(() => {});
      throw e;
    }
    return reply.status(201).send(view(ctx, await one(c.sub, id)));
  });

  app.get(`${prefix}/edits`, async (req) => {
    const c = await auth(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const { rows } = await ctx.db.query<Joined>(`${SELECT} WHERE e.owner_sub = $1 ORDER BY e.created_at DESC LIMIT $2`, [c.sub, q.limit]);
    return { edits: rows.map((e) => view(ctx, e)) };
  });

  app.get(`${prefix}/edits/:id`, async (req) => view(ctx, await one((await auth(req)).sub, idOf(req.params))));

  /** The photo before the edit, or the final result once done. Decrypted per request, never cached. */
  app.get(`${prefix}/edits/:id/images/:which`, async (req, reply) => {
    const c = await auth(req);
    const { which } = z.object({ which: z.enum(["original", "result"]) }).parse(req.params);
    const e = await one(c.sub, idOf(req.params));
    if (which === "result" && e.status !== "done") throw err(409, "not_done", "This edit has no result yet");
    const img = await blobs.get(e.id, e.blob_key, which === "result" ? "current" : "original");
    if (!img) throw err(410, "expired", "This edit's images were deleted");
    return reply.header("content-type", contentType(detectFormat(img) ?? "png")).header("cache-control", "private, no-store").send(img);
  });

  app.post(`${prefix}/edits/:id/cancel`, async (req) => {
    const c = await auth(req);
    const e = await one(c.sub, idOf(req.params));
    if (e.status !== "running") throw err(409, "conflict", "This edit isn't running");
    await stopJob(ctx, e.job_id);
    await ctx.db.query(
      `UPDATE edits SET status = 'cancelled', failure = 'cancelled', job_id = NULL, finished_at = now(), expires_at = ${finalExpiry}, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [e.id],
    );
    await blobs.delete(e.id, "current").catch(() => {});
    return view(ctx, await one(c.sub, e.id));
  });

  app.delete(`${prefix}/edits/:id`, async (req, reply) => {
    const c = await auth(req);
    const e = await one(c.sub, idOf(req.params));
    if (e.status === "running") await stopJob(ctx, e.job_id);
    await ctx.db.query("DELETE FROM edits WHERE id = $1", [e.id]);
    await blobs.deleteRow(e.id);
    return reply.status(204).send();
  });
}

// ---------- the engine ----------

let running = false;
let again = false;
/** Moves every running edit forward: a finished step starts the next one. Called on each finished job and every 10 s. */
export async function runEdits(ctx: Ctx, log: (e: unknown, msg: string) => void) {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      const { rows } = await ctx.db.query<Joined>(`${SELECT} WHERE e.status = 'running' ORDER BY e.created_at LIMIT 200`);
      for (const e of rows) await advance(ctx, e, log);
    } while (again);
  } finally {
    running = false;
  }
}

async function advance(ctx: Ctx, e: Joined, log: (e: unknown, msg: string) => void) {
  const blobs = blobsOf(ctx);
  const notify = notifier(ctx);
  const d = openRow<EditData>(ctx.sealer, e.id, e.data);
  const tell = (status: "done" | "failed") => { notify.forEdit(e.owner_sub, e.id, status).catch((x) => log(x, "notification failed")); };

  const finish = async () => {
    const img = await blobs.get(e.id, e.blob_key, "current");
    if (!img) throw new Error("edit image missing");
    const format = detectFormat(img) ?? "png";
    const size = imageSize(img, format) ?? { width: 0, height: 0 };
    await ctx.db.query(
      `UPDATE edits SET status = 'done', step = $2, job_id = NULL, result = $3, finished_at = now(), expires_at = ${finalExpiry}, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [e.id, d.steps.length, JSON.stringify({ format, ...size, bytes: img.length })],
    );
    tell("done");
  };
  const fail = async (code: string) => {
    await ctx.db.query(
      `UPDATE edits SET status = 'failed', failure = $2, job_id = NULL, finished_at = now(), expires_at = ${finalExpiry}, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [e.id, code],
    );
    await blobs.delete(e.id, "current").catch(() => {});
    tell("failed");
  };
  const start = async (n: number, notes: string[]) => {
    if (n >= d.steps.length) {
      await ctx.db.query("UPDATE edits SET notes = $2 WHERE id = $1", [e.id, JSON.stringify(notes)]);
      return finish();
    }
    const step = d.steps[n]!;
    const img = await blobs.get(e.id, e.blob_key, "current");
    if (!img) throw new Error("edit image missing");
    const jobId = await startStep(ctx, e.owner_sub, step, img, { editId: e.id, summary: { title: `Edit · ${stepTitle(step)}` } });
    const { rowCount } = await ctx.db.query(
      "UPDATE edits SET step = $2, job_id = $3, notes = $4, updated_at = now() WHERE id = $1 AND status = 'running'",
      [e.id, n, jobId, JSON.stringify(notes)],
    );
    if (!rowCount) await stopJob(ctx, jobId); // cancelled meanwhile
  };

  try {
    if (!e.job_id) return await start(e.step, e.notes);
    if (e.job_status === "queued" || e.job_status === "running") return;
    const step = d.steps[e.step];
    if (e.job_status === "done" && step) {
      const result = await readResult(ctx, e.job_id, 1, e.job_key);
      await blobs.put(e.id, e.blob_key, "current", result);
      await dropJob(ctx, e.job_id);
      return await start(e.step + 1, e.notes);
    }
    if (e.job_status === "failed" && step && skippable(step, e.job_failure)) {
      await dropJob(ctx, e.job_id);
      return await start(e.step + 1, [...e.notes, `${e.step}:no_face_found`]);
    }
    const code = e.job_status === "failed" ? e.job_failure ?? "internal" : "cancelled";
    if (e.job_status) await dropJob(ctx, e.job_id).catch(() => {});
    await fail(code);
  } catch (x) {
    // A step that can no longer run (worker gone, character deleted…) fails the edit; anything else is retried.
    if (x instanceof HttpError) return fail(x.code);
    log(x, "edit step failed");
  }
}

/** Past their keep date: images and row deleted. */
export async function expireEdits(ctx: Ctx) {
  const { rows } = await ctx.db.query<{ id: string }>("DELETE FROM edits WHERE expires_at < now() RETURNING id");
  const blobs = blobsOf(ctx);
  for (const r of rows) await blobs.deleteRow(r.id).catch(() => {});
}
