import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { err, readResult, type Ctx } from "./jobs.ts";
import { contentType } from "./images.ts";
import { openRow } from "./sealed.ts";

/**
 * Locke as a read-only vault data source (contract "ilven-vault-source/1", Ilven's integrations/locke-vault).
 * Items are the results of the user's finished Create and Editor jobs (not workflow steps: those already land in
 * the vault). Collections: "all", "created" (run by hand) and one per schedule, so a workflow can watch one
 * schedule. Supports `addedAfter` (when the result was finished), oldest first.
 * The vault calls it with the user's own credential, or Locke's delegated key for that user (workflows).
 */
const querySchema = z.object({
  text: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  collection: z.string().max(100).optional(),
  addedAfter: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(500).optional(),
}).loose();

export function registerSourceApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: (req: FastifyRequest) => Promise<{ sub: string }>) {
  const base = `${prefix}/vault-source`;

  app.get(base, async (req) => {
    const c = await auth(req);
    const { rows } = await ctx.db.query<{ id: string; prompt_id: string; data: string }>(
      "SELECT s.id, s.prompt_id, p.data FROM schedules s JOIN prompts p ON p.id = s.prompt_id WHERE s.owner_sub = $1 ORDER BY s.created_at",
      [c.sub],
    );
    return {
      name: "Locke",
      description: "Images made in Locke: what you created by hand and what your schedules made.",
      status: "ready",
      experimental: false,
      filters: { text: false, dateRange: true, favorite: false, collection: true, addedAfter: true },
      collections: [
        { id: "all", name: "All results" },
        { id: "created", name: "Created by hand" },
        ...rows.map((r) => ({ id: r.id, name: `Scheduled · ${openRow<{ name: string }>(ctx.sealer, r.prompt_id, r.data).name}` })),
      ],
    };
  });

  // Paged by job (a job's results always come together). Cursor: "<finished_at ISO>|<job id>".
  app.post(`${base}/query`, async (req) => {
    const c = await auth(req);
    const q = querySchema.parse(req.body ?? {});
    const asc = !!q.addedAfter;
    const [cAt, cId] = q.cursor ? q.cursor.split("|") : [];
    const coll = q.collection ?? "all";
    const jobs = Math.max(1, Math.ceil(q.limit / 4));
    const params: unknown[] = [c.sub, q.from ?? null, q.to ?? null, jobs, q.addedAfter ?? null, cAt || null, cId ?? ""];
    let where = `owner_sub = $1 AND status = 'done' AND NOT is_test AND workflow_run_id IS NULL AND type IN ('generate', 'face_swap')
      AND ($2::timestamptz IS NULL OR finished_at >= $2) AND ($3::timestamptz IS NULL OR finished_at <= $3)
      AND ($5::timestamptz IS NULL OR finished_at > $5)`;
    where += asc
      ? " AND ($6::timestamptz IS NULL OR (finished_at, id) > ($6::timestamptz, $7::text))"
      : " AND ($6::timestamptz IS NULL OR (finished_at, id) < ($6::timestamptz, $7::text))";
    if (coll === "created") where += " AND schedule_id IS NULL";
    else if (coll !== "all") { params.push(coll); where += ` AND schedule_id = $${params.length}`; }
    const { rows } = await ctx.db.query<{ id: string; finished_at: Date; result_count: number; summary: string | null }>(
      `SELECT id, finished_at, result_count, summary FROM jobs WHERE ${where} ORDER BY finished_at ${asc ? "ASC" : "DESC"}, id ${asc ? "ASC" : "DESC"} LIMIT $4`,
      params,
    );
    const items = rows.flatMap((j) => {
      let title = "Locke";
      try { title = (JSON.parse(ctx.sealer.open(j.summary ?? "")) as { title?: string }).title ?? title; } catch { /* keep the default */ }
      const at = j.finished_at.toISOString();
      return Array.from({ length: j.result_count ?? 0 }, (_, i) => ({
        ref: `${j.id}.${i + 1}`, name: `${title.slice(0, 80)} ${i + 1}.png`, date: at, addedAt: at, description: title.slice(0, 1000),
      }));
    });
    const last = rows[rows.length - 1];
    return { items, cursor: rows.length === jobs && last ? `${last.finished_at.toISOString()}|${last.id}` : null };
  });

  app.get(`${base}/items/:ref/content`, async (req, reply) => {
    const c = await auth(req);
    const { ref } = z.object({ ref: z.string().regex(/^job_[A-Za-z0-9_-]+\.[1-4]$/) }).parse(req.params);
    const dot = ref.lastIndexOf(".");
    const id = ref.slice(0, dot);
    const n = Number(ref.slice(dot + 1));
    const { rows } = await ctx.db.query<{ job_key: string | null; format: string }>(
      `SELECT j.job_key, r.format FROM jobs j JOIN job_results r ON r.job_id = j.id
       WHERE j.id = $1 AND j.owner_sub = $2 AND j.status = 'done' AND NOT j.is_test AND r.n = $3`,
      [id, c.sub, n],
    );
    if (!rows[0]) throw err(404, "not_found", "Not found");
    const image = await readResult(ctx, id, n, rows[0].job_key);
    const file = `${id}-${n}.${rows[0].format === "jpeg" ? "jpg" : "png"}`;
    return reply.header("content-type", contentType(rows[0].format as "png" | "jpeg"))
      .header("content-disposition", `attachment; filename="${encodeURIComponent(file)}"`)
      .header("cache-control", "private, no-store").send(image);
  });
}
