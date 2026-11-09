import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "@ilven/common";
import { err, newId, type Ctx } from "./jobs.ts";
import { cleanImage, generateJob, readMultipart } from "./builders.ts";
import { characterStore, type Auth } from "./characters.ts";
import { contentType, detectFormat } from "./images.ts";
import { newBlobKey, openRow, RowBlobs, sealRow } from "./sealed.ts";
import { nextRun, scheduleSpecSchema, type ScheduleSpec } from "./schedule.ts";

/**
 * Saved prompts (HANDOFF §5.1) and their schedules. A prompt keeps every fragment (switched off ones too), its
 * settings, an optional saved character and up to 4 reference photos. A schedule runs the prompt on a wall-clock
 * cadence; a run is skipped while the previous one still waits or runs (no pile-up). Its results show in
 * Jobs › Scheduled and in the vault's Locke source (one collection per schedule).
 */
export const MAX_PROMPTS = 200;
export const MAX_ACTIVE_SCHEDULES = 10;
const frag = z.object({ text: z.string().trim().min(1).max(500), on: z.boolean() });
export const promptSchema = z.object({
  name: z.string().trim().min(1).max(80),
  positive: z.array(frag).max(60),
  negative: z.array(frag).max(60).default([]),
  style: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  aspect: z.enum(["square", "portrait", "landscape"]).default("portrait"),
  count: z.number().int().min(1).max(4).default(1),
  mode: z.enum(["fast", "quality"]).default("fast"),
  character: z.string().max(64).nullable().default(null),
  references: z.array(z.string().min(1).max(64)).max(4).default([]),
});
type PromptData = Omit<z.infer<typeof promptSchema>, "references">;
interface Ref { id: string; bytes: number; format: string }
interface PromptRow { id: string; owner_sub: string; data: string; blob_key: string; refs: Ref[]; created_at: Date; updated_at: Date }
interface ScheduleRow {
  id: string; owner_sub: string; prompt_id: string; spec: ScheduleSpec; active: boolean; keep_results: boolean; next_run_at: Date | null;
  last_run_at: Date | null; run_count: number; skipped_count: number; last_error: string | null; created_at: Date;
}

export function promptStore(ctx: Ctx) {
  const blobs = new RowBlobs(ctx.store, ctx.sealer, "prompts");
  const chars = characterStore(ctx);
  const get = async (sub: string, id: string) => {
    const { rows } = await ctx.db.query<PromptRow>("SELECT * FROM prompts WHERE id = $1 AND owner_sub = $2", [id, sub]);
    if (!rows[0]) throw err(404, "prompt_not_found", "Prompt not found");
    return rows[0];
  };
  const data = (r: PromptRow) => openRow<PromptData>(ctx.sealer, r.id, r.data);
  /** Queues one run of a saved prompt. */
  const run = async (r: PromptRow, extra: { scheduleId?: string; keep?: boolean } = {}) => {
    const d = data(r);
    const positive = d.positive.filter((f) => f.on).map((f) => f.text);
    if (!positive.length) throw err(422, "empty_prompt", "This prompt has no fragment switched on");
    const refs: Buffer[] = [];
    for (const ref of r.refs) {
      const b = await blobs.get(r.id, r.blob_key, ref.id);
      if (b) refs.push(b);
    }
    const character = d.character ? await chars.load(r.owner_sub, d.character) : null;
    return generateJob(ctx, r.owner_sub, {
      positive, negative: d.negative.filter((f) => f.on).map((f) => f.text), style: d.style, aspect: d.aspect, count: d.count, mode: d.mode, seed: null,
    }, refs, character, { scheduleId: extra.scheduleId, keep: extra.keep, summary: { prompt: d.name, ...(extra.scheduleId ? { schedule: d.name } : {}), ...(character ? { character: character.name } : {}) } });
  };
  return { blobs, get, data, run };
}

const scheduleView = (s: ScheduleRow | undefined) => s ? {
  id: s.id, spec: s.spec, active: s.active, keepResults: s.keep_results, nextRunAt: s.active ? s.next_run_at : null, lastRunAt: s.last_run_at,
  runCount: s.run_count, skippedCount: s.skipped_count, lastError: s.last_error,
} : null;

export function registerPromptApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: Auth) {
  const ps = promptStore(ctx);
  const idOf = (p: unknown) => z.object({ id: z.string().max(64) }).parse(p).id;
  const view = (r: PromptRow, s?: ScheduleRow) => ({
    id: r.id, ...ps.data(r), references: r.refs.map((x) => ({ id: x.id })), schedule: scheduleView(s), createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const scheduleOf = async (promptId: string) =>
    (await ctx.db.query<ScheduleRow>("SELECT * FROM schedules WHERE prompt_id = $1", [promptId])).rows[0];

  /** Validates the body and stores the reference photos (replacing all previous ones). */
  const save = async (sub: string, id: string | null, req: Parameters<typeof readMultipart>[0]) => {
    const { params, files } = await readMultipart(req);
    const p = promptSchema.parse(params);
    if (new Set(p.references).size !== p.references.length || files.size !== p.references.length || p.references.some((f) => !files.has(f))) {
      throw err(400, "bad_request", "Every uploaded file must be a reference, once");
    }
    if (p.character) await characterStore(ctx).get(sub, p.character);
    const cleaned = p.references.map((f) => cleanImage(f, files.get(f)).data);
    const { references: _r, ...data } = p;
    let row: PromptRow;
    if (id) {
      row = await ps.get(sub, id);
    } else {
      const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM prompts WHERE owner_sub = $1", [sub]);
      if (rows[0]!.n >= MAX_PROMPTS) throw err(409, "too_many", `At most ${MAX_PROMPTS} saved prompts`);
      const nid = newId("prm");
      await ctx.db.query("INSERT INTO prompts (id, owner_sub, data, blob_key) VALUES ($1, $2, $3, $4)", [nid, sub, sealRow(ctx.sealer, nid, data), newBlobKey(ctx.sealer)]);
      row = await ps.get(sub, nid);
    }
    const refs: Ref[] = [];
    for (const img of cleaned) {
      const ref: Ref = { id: newId("rf"), bytes: 0, format: detectFormat(img)! };
      ref.bytes = await ps.blobs.put(row.id, row.blob_key, ref.id, img);
      refs.push(ref);
    }
    await ctx.db.query("UPDATE prompts SET data = $2, refs = $3, updated_at = now() WHERE id = $1", [row.id, sealRow(ctx.sealer, row.id, data), JSON.stringify(refs)]);
    for (const old of row.refs) await ps.blobs.delete(row.id, old.id).catch(() => {});
    return view(await ps.get(sub, row.id), await scheduleOf(row.id));
  };

  app.get(`${prefix}/prompts`, async (req) => {
    const c = await auth(req);
    const { rows } = await ctx.db.query<PromptRow>("SELECT * FROM prompts WHERE owner_sub = $1 ORDER BY updated_at DESC", [c.sub]);
    const { rows: ss } = await ctx.db.query<ScheduleRow>("SELECT * FROM schedules WHERE owner_sub = $1", [c.sub]);
    return { prompts: rows.map((r) => view(r, ss.find((s) => s.prompt_id === r.id))) };
  });
  app.post(`${prefix}/prompts`, async (req, reply) => reply.status(201).send(await save((await auth(req)).sub, null, req)));
  app.put(`${prefix}/prompts/:id`, async (req) => save((await auth(req)).sub, idOf(req.params), req));
  app.delete(`${prefix}/prompts/:id`, async (req, reply) => {
    const c = await auth(req);
    const r = await ps.get(c.sub, idOf(req.params));
    await ctx.db.query("DELETE FROM prompts WHERE id = $1", [r.id]);
    await ps.blobs.deleteRow(r.id).catch(() => {});
    return reply.status(204).send();
  });
  app.get(`${prefix}/prompts/:id/references/:ref`, async (req, reply) => {
    const c = await auth(req);
    const { ref } = z.object({ ref: z.string().max(64) }).parse(req.params);
    const r = await ps.get(c.sub, idOf(req.params));
    const x = r.refs.find((f) => f.id === ref);
    const data = x && (await ps.blobs.get(r.id, r.blob_key, x.id));
    if (!x || !data) throw err(404, "not_found", "Reference not found");
    return reply.header("content-type", contentType(x.format as "png" | "jpeg")).header("cache-control", "private, max-age=3600").send(data);
  });
  app.post(`${prefix}/prompts/:id/run`, async (req, reply) => {
    const c = await auth(req);
    const r = await ps.get(c.sub, idOf(req.params));
    const s = await scheduleOf(r.id);
    const jobId = await ps.run(r, s ? { scheduleId: s.id, keep: s.keep_results } : {});
    if (s) await ctx.db.query("UPDATE schedules SET run_count = run_count + 1, last_run_at = now(), last_error = NULL WHERE id = $1", [s.id]);
    return reply.status(201).send({ jobId });
  });

  // ---------- schedule (one per prompt) ----------
  app.put(`${prefix}/prompts/:id/schedule`, async (req) => {
    const c = await auth(req);
    const r = await ps.get(c.sub, idOf(req.params));
    const b = z.object({ spec: scheduleSpecSchema, active: z.boolean().default(true), keepResults: z.boolean().default(false) }).parse(req.body);
    if (b.active) {
      const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM schedules WHERE owner_sub = $1 AND active AND prompt_id <> $2", [c.sub, r.id]);
      if (rows[0]!.n >= MAX_ACTIVE_SCHEDULES) throw err(409, "too_many", `At most ${MAX_ACTIVE_SCHEDULES} active schedules`);
    }
    const next = b.active ? new Date(nextRun(b.spec, Date.now())) : null;
    await ctx.db.query(
      `INSERT INTO schedules (id, owner_sub, prompt_id, spec, active, keep_results, next_run_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (prompt_id) DO UPDATE SET spec = $4, active = $5, keep_results = $6, next_run_at = $7, last_error = NULL`,
      [newId("sch"), c.sub, r.id, JSON.stringify(b.spec), b.active, b.keepResults, next],
    );
    return view(r, await scheduleOf(r.id));
  });
  app.delete(`${prefix}/prompts/:id/schedule`, async (req) => {
    const c = await auth(req);
    const r = await ps.get(c.sub, idOf(req.params));
    await ctx.db.query("DELETE FROM schedules WHERE prompt_id = $1", [r.id]);
    return view(r);
  });
}

/** Runs due schedules. Called every 20 s; one Locke instance, so a simple in-process guard prevents overlap. */
let ticking = false;
export async function runSchedules(ctx: Ctx, log: (e: unknown) => void) {
  if (ticking) return;
  ticking = true;
  try {
    const ps = promptStore(ctx);
    const { rows } = await ctx.db.query<ScheduleRow>("SELECT * FROM schedules WHERE active AND next_run_at <= now() ORDER BY next_run_at LIMIT 50");
    for (const s of rows) {
      const next = new Date(nextRun(s.spec, Date.now()));
      try {
        const busy = await ctx.db.query("SELECT 1 FROM jobs WHERE schedule_id = $1 AND status IN ('queued', 'running') LIMIT 1", [s.id]);
        if (busy.rowCount) {
          await ctx.db.query("UPDATE schedules SET skipped_count = skipped_count + 1, next_run_at = $2 WHERE id = $1", [s.id, next]);
          continue;
        }
        const r = (await ctx.db.query<PromptRow>("SELECT * FROM prompts WHERE id = $1", [s.prompt_id])).rows[0]!;
        await ps.run(r, { scheduleId: s.id, keep: s.keep_results });
        await ctx.db.query("UPDATE schedules SET run_count = run_count + 1, last_run_at = now(), last_error = NULL, next_run_at = $2 WHERE id = $1", [s.id, next]);
      } catch (e) {
        const code = e instanceof HttpError ? e.code : "internal";
        if (code === "internal") log(e);
        await ctx.db.query("UPDATE schedules SET last_error = $2, next_run_at = $3 WHERE id = $1", [s.id, code, next]);
      }
    }
  } finally {
    ticking = false;
  }
}
