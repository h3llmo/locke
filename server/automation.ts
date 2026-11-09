import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, type Caller } from "@ilven/common";
import { err, newId, purgeJob, readResult, type Ctx } from "./jobs.ts";
import { faceSwapJob, imageJob, upscaleJob } from "./builders.ts";
import { characterStore, type Auth } from "./characters.ts";
import { detectFormat, contentType } from "./images.ts";
import { openRow, sealRow } from "./sealed.ts";
import { VaultClient, VaultError, type SourceInfo } from "./vault.ts";
import { notifier } from "./notify.ts";

/**
 * Automate (HANDOFF §5.4): workflows watch vault sources and run steps on every new image, in this order:
 * Enhance / Face swap (the user's order) → Blur, always last. Each new image is copied into the vault, then every
 * finished step adds a version to that vault item (linear history: "Undo last step" in the vault removes the last).
 *
 * Workflows run while the user is away, so Locke holds a delegated key for the user (Nevli, issued only while the
 * user is logged in and asked for it; revocable in Ilven-Account). It's valid at Locke Vault and at the services
 * the vault reads sources from, nowhere else, and only for that user.
 */
export const DELEGATION_AUDIENCE = ["locke-vault", "dms", "locke"];
const MAX_WORKFLOWS = 20;
const IN_FLIGHT_PER_WORKFLOW = 2;
const CHECK_EVERY_S = 60;
const FULL_SCAN_EVERY_S = 300;
const FULL_SCAN_PAGES = 50; // 5,000 photos per collection at most

const stepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enhance"), strength: z.enum(["subtle", "balanced", "strong"]).default("balanced") }),
  z.object({ op: z.literal("face_swap"), characters: z.array(z.string().max(64)).min(1).max(4) }),
  z.object({ op: z.literal("upscale"), scale: z.union([z.literal(2), z.literal(4)]).default(2) }),
]);
export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sources: z.array(z.object({
    source: z.string().max(40),
    collection: z.string().max(100).nullable().default(null),
    label: z.string().trim().min(1).max(160),
  })).min(1).max(5),
  steps: z.array(stepSchema).max(4).default([]),
  blur: z.object({ strength: z.number().int().min(0).max(100) }).nullable().default(null),
}).refine((w) => w.steps.length > 0 || w.blur, { message: "Add at least one step" });
export type WorkflowData = z.infer<typeof workflowSchema>;
type Step = { op: "enhance"; strength: string } | { op: "face_swap"; characters: string[] } | { op: "upscale"; scale: 2 | 4 } | { op: "blur"; strength: number };
type Cursor = { since?: string; listed?: boolean; scannedAt?: string };
interface WorkflowRow {
  id: string; owner_sub: string; data: string; active: boolean; activated_at: Date | null; cursors: Record<string, Cursor>;
  last_check_at: Date | null; last_error: string | null; created_at: Date; updated_at: Date;
}
interface RunRow {
  id: string; workflow_id: string; owner_sub: string; source: string; ref: string; status: string; item_id: string | null;
  step: number; job_id: string | null; notes: string[]; failure: string | null; created_at: Date; updated_at: Date;
}

const STEP_TITLES: Record<Step["op"], string> = { face_swap: "Face swap", enhance: "Enhance", upscale: "Upscale", blur: "Blur" };
const keyOf = (s: { source: string; collection: string | null }) => `${s.source}|${s.collection ?? ""}`;
export const stepsOf = (d: WorkflowData): Step[] => [...d.steps, ...(d.blur ? [{ op: "blur" as const, strength: d.blur.strength }] : [])];

export interface AutomationDeps { nevliUrl: string; appSecret: string; vaultUrl: string }

export function automation(ctx: Ctx, deps: AutomationDeps) {
  const keyFor = async (sub: string): Promise<string | null> => {
    const { rows } = await ctx.db.query<{ sealed_key: string }>("SELECT sealed_key FROM automation WHERE owner_sub = $1", [sub]);
    return rows[0] ? ctx.sealer.open(rows[0].sealed_key) : null;
  };
  const vaultFor = async (sub: string) => {
    const k = await keyFor(sub);
    return k ? new VaultClient(deps.vaultUrl, k) : null;
  };
  const nevli = async (path: string, body: object) => {
    const res = await fetch(`${deps.nevliUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "locke", secret: deps.appSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw err(res.status === 401 ? 401 : 502, String(data?.error ?? "nevli_error"), String(data?.message ?? `Nevli answered HTTP ${res.status}`));
    return data!;
  };

  /** The user turns automation on from Locke (logged in): Nevli issues Locke a key for them. */
  const enable = async (caller: Caller) => {
    if (caller.kind !== "identity") throw err(403, "login_required", "Turn automation on from Locke itself");
    const r = await nevli("/internal/apps/delegations", {
      userToken: caller.credential, audience: DELEGATION_AUDIENCE, purpose: "Locke automated workflows",
    }) as { key: string; prefix: string; sub: string };
    if (r.sub !== caller.sub) throw err(409, "conflict", "Login changed while turning automation on");
    await ctx.db.query(
      `INSERT INTO automation (owner_sub, sealed_key, prefix) VALUES ($1, $2, $3)
       ON CONFLICT (owner_sub) DO UPDATE SET sealed_key = $2, prefix = $3, created_at = now()`,
      [caller.sub, ctx.sealer.seal(r.key), r.prefix],
    );
  };
  const disable = async (sub: string) => {
    await nevli("/internal/apps/delegations/revoke", { sub }).catch(() => {});
    await ctx.db.query("DELETE FROM automation WHERE owner_sub = $1", [sub]);
    await ctx.db.query("UPDATE workflows SET active = false, updated_at = now() WHERE owner_sub = $1", [sub]);
  };
  return { keyFor, vaultFor, enable, disable };
}

export function registerAutomationApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: (req: Parameters<Auth>[0]) => Promise<Caller>, deps: AutomationDeps) {
  const auto = automation(ctx, deps);
  const chars = characterStore(ctx);
  const idOf = (p: unknown) => z.object({ id: z.string().max(64) }).parse(p).id;
  const get = async (sub: string, id: string) => {
    const { rows } = await ctx.db.query<WorkflowRow>("SELECT * FROM workflows WHERE id = $1 AND owner_sub = $2", [id, sub]);
    if (!rows[0]) throw err(404, "workflow_not_found", "Workflow not found");
    return rows[0];
  };
  const validate = async (sub: string, body: unknown) => {
    const d = workflowSchema.parse(body);
    for (const s of d.steps) if (s.op === "face_swap") for (const c of s.characters) await chars.get(sub, c);
    if (new Set(d.sources.map(keyOf)).size !== d.sources.length) throw err(400, "bad_request", "A source is listed twice");
    return d;
  };
  const view = async (w: WorkflowRow) => {
    const { rows } = await ctx.db.query<{ status: string; n: number; today: number; last: Date | null }>(
      `SELECT status, count(*)::int AS n, count(*) FILTER (WHERE updated_at > now() - interval '24 hours')::int AS today, max(updated_at) AS last
       FROM workflow_runs WHERE workflow_id = $1 AND status <> 'baseline' GROUP BY status`,
      [w.id],
    );
    const by = (s: string) => rows.find((r) => r.status === s);
    const waiting = await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM workflow_runs r JOIN jobs j ON j.id = r.job_id WHERE r.workflow_id = $1 AND j.status = 'queued'",
      [w.id],
    );
    return {
      id: w.id, ...openRow<WorkflowData>(ctx.sealer, w.id, w.data), active: w.active, activatedAt: w.activated_at,
      lastCheckAt: w.last_check_at, lastError: w.last_error, createdAt: w.created_at, updatedAt: w.updated_at,
      stats: {
        pending: by("pending")?.n ?? 0, running: by("running")?.n ?? 0, waitingForGpu: waiting.rows[0]!.n,
        done: by("done")?.n ?? 0, doneToday: by("done")?.today ?? 0, failed: by("failed")?.n ?? 0, failedToday: by("failed")?.today ?? 0,
        lastDoneAt: by("done")?.last ?? null,
      },
    };
  };

  // ---------- automation key ----------
  app.get(`${prefix}/automation`, async (req) => {
    const c = await auth(req);
    const { rows } = await ctx.db.query<{ prefix: string; created_at: Date }>("SELECT prefix, created_at FROM automation WHERE owner_sub = $1", [c.sub]);
    if (!rows[0]) return { enabled: false };
    // Still valid? The user may have revoked it in Ilven-Account.
    let working = true;
    try { await (await auto.vaultFor(c.sub))!.quota(); } catch (e) { working = !(e instanceof VaultError && e.status === 401); }
    return { enabled: true, working, since: rows[0].created_at };
  });
  app.post(`${prefix}/automation`, async (req) => {
    await auto.enable(await auth(req));
    return { enabled: true, working: true };
  });
  app.delete(`${prefix}/automation`, async (req) => {
    await auto.disable((await auth(req)).sub);
    return { enabled: false };
  });

  // ---------- workflows ----------
  app.get(`${prefix}/workflows`, async (req) => {
    const c = await auth(req);
    const { rows } = await ctx.db.query<WorkflowRow>("SELECT * FROM workflows WHERE owner_sub = $1 ORDER BY created_at", [c.sub]);
    return { workflows: await Promise.all(rows.map(view)) };
  });
  app.get(`${prefix}/workflows/:id`, async (req) => view(await get((await auth(req)).sub, idOf(req.params))));
  app.post(`${prefix}/workflows`, async (req, reply) => {
    const c = await auth(req);
    const d = await validate(c.sub, req.body);
    const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM workflows WHERE owner_sub = $1", [c.sub]);
    if (rows[0]!.n >= MAX_WORKFLOWS) throw err(409, "too_many", `At most ${MAX_WORKFLOWS} workflows`);
    const id = newId("wf");
    await ctx.db.query("INSERT INTO workflows (id, owner_sub, data) VALUES ($1, $2, $3)", [id, c.sub, sealRow(ctx.sealer, id, d)]);
    return reply.status(201).send(await view(await get(c.sub, id)));
  });
  app.put(`${prefix}/workflows/:id`, async (req) => {
    const c = await auth(req);
    const w = await get(c.sub, idOf(req.params));
    const d = await validate(c.sub, req.body);
    // A source added to a running workflow starts from now (images already there are left alone).
    const cursors = { ...w.cursors };
    if (w.active) for (const s of d.sources) if (!cursors[keyOf(s)]) cursors[keyOf(s)] = { since: new Date().toISOString() };
    await ctx.db.query("UPDATE workflows SET data = $2, cursors = $3, updated_at = now() WHERE id = $1", [w.id, sealRow(ctx.sealer, w.id, d), JSON.stringify(cursors)]);
    return view(await get(c.sub, w.id));
  });
  // Turning a workflow on: it handles images that arrive from now on.
  app.patch(`${prefix}/workflows/:id`, async (req) => {
    const c = await auth(req);
    const w = await get(c.sub, idOf(req.params));
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    if (active && !w.active) {
      if (!(await auto.keyFor(c.sub))) throw err(409, "automation_required", "Allow Locke to work while you're away first");
      await ctx.db.query("UPDATE workflows SET active = true, activated_at = now(), cursors = '{}', last_error = NULL, last_check_at = NULL, updated_at = now() WHERE id = $1", [w.id]);
    } else if (!active) {
      await ctx.db.query("UPDATE workflows SET active = false, updated_at = now() WHERE id = $1", [w.id]);
    }
    return view(await get(c.sub, w.id));
  });
  app.delete(`${prefix}/workflows/:id`, async (req, reply) => {
    const c = await auth(req);
    const w = await get(c.sub, idOf(req.params));
    const { rows } = await ctx.db.query<{ id: string }>(
      `UPDATE jobs SET status = 'cancelled', failure_code = 'cancelled', finished_at = now(), expires_at = now() + interval '7 days'
       WHERE status = 'queued' AND workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = $1) RETURNING id`,
      [w.id],
    );
    for (const j of rows) await purgeJob(ctx, j.id).catch(() => {});
    await ctx.db.query("UPDATE jobs SET cancel_requested = true WHERE status = 'running' AND workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = $1)", [w.id]);
    await ctx.db.query("DELETE FROM workflows WHERE id = $1", [w.id]);
    return reply.status(204).send();
  });
  app.get(`${prefix}/workflows/:id/runs`, async (req) => {
    const c = await auth(req);
    const w = await get(c.sub, idOf(req.params));
    const { rows } = await ctx.db.query<RunRow & { job_status: string | null; queue: number | null }>(
      `SELECT r.*, j.status AS job_status FROM workflow_runs r LEFT JOIN jobs j ON j.id = r.job_id
       WHERE r.workflow_id = $1 AND r.status <> 'baseline' ORDER BY r.created_at DESC LIMIT 50`,
      [w.id],
    );
    return {
      runs: rows.map((r) => ({
        id: r.id, source: r.source, status: r.status, itemId: r.item_id, step: r.step, jobStatus: r.job_status, notes: r.notes,
        failure: r.failure, createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    };
  });
  app.post(`${prefix}/workflows/:id/runs/:run/retry`, async (req) => {
    const c = await auth(req);
    const w = await get(c.sub, idOf(req.params));
    const { run } = z.object({ run: z.string().max(64) }).parse(req.params);
    const r = await ctx.db.query("UPDATE workflow_runs SET status = 'pending', failure = NULL, job_id = NULL, updated_at = now() WHERE id = $1 AND workflow_id = $2 AND status = 'failed'", [run, w.id]);
    if (!r.rowCount) throw err(409, "conflict", "Only failed runs can be retried");
    return { ok: true };
  });
}

// ---------- the engine ----------

/**
 * Every 20 s: look for new images in active workflows' sources (each workflow at most once a minute), then move
 * runs forward one step at a time. One Locke instance: an in-process guard prevents overlapping ticks.
 */
let ticking = false;
export async function runWorkflows(ctx: Ctx, deps: AutomationDeps, log: (e: unknown, msg: string) => void) {
  if (ticking) return;
  ticking = true;
  try {
    await discover(ctx, deps, log);
    await advance(ctx, deps, log);
  } finally {
    ticking = false;
  }
}

async function discover(ctx: Ctx, deps: AutomationDeps, log: (e: unknown, msg: string) => void) {
  const auto = automation(ctx, deps);
  const { rows } = await ctx.db.query<WorkflowRow>(
    `SELECT w.* FROM workflows w JOIN automation a ON a.owner_sub = w.owner_sub
     WHERE w.active AND (w.last_check_at IS NULL OR w.last_check_at < now() - make_interval(secs => $1::int))
     ORDER BY w.last_check_at NULLS FIRST LIMIT 20`,
    [CHECK_EVERY_S],
  );
  const infos = new Map<string, SourceInfo[]>();
  for (const w of rows) {
    const d = openRow<WorkflowData>(ctx.sealer, w.id, w.data);
    const cursors = { ...w.cursors };
    let error: string | null = null;
    try {
      const vault = (await auto.vaultFor(w.owner_sub))!;
      if (!infos.has(w.owner_sub)) infos.set(w.owner_sub, await vault.sources());
      for (const src of d.sources) {
        const info = infos.get(w.owner_sub)!.find((s) => s.id === src.source);
        if (!info || !info.available || info.status !== "ready") { error = "source_unavailable"; continue; }
        const k = keyOf(src);
        const cur: Cursor = { ...cursors[k] };
        const insert = async (refs: string[], status: "pending" | "baseline") => {
          if (!refs.length) return;
          await ctx.db.query(
            `INSERT INTO workflow_runs (id, workflow_id, owner_sub, source, ref, status)
             SELECT x.id, $1, $2, $3, x.ref, $4 FROM unnest($5::text[], $6::text[]) AS x(id, ref)
             ON CONFLICT (workflow_id, source, ref) DO NOTHING`,
            [w.id, w.owner_sub, src.source, status, refs.map(() => newId("run")), refs],
          );
        };
        const collection = src.collection ? { collection: src.collection } : {};
        if (info.filters.addedAfter) {
          // New since the last look (or since the workflow was turned on), oldest first.
          let since = cur.since ?? (w.activated_at ?? new Date()).toISOString();
          let cursor: string | null = null;
          for (let page = 0; page < 4; page++) {
            const r = await vault.query(src.source, { addedAfter: since, limit: 50, ...collection, ...(cursor ? { cursor } : {}) });
            await insert(r.items.map((i) => i.ref), "pending");
            for (const i of r.items) if (i.addedAt && Date.parse(i.addedAt) > Date.parse(since)) since = new Date(i.addedAt).toISOString();
            cursor = r.cursor;
            if (!cursor) break;
          }
          cursors[k] = { since };
        } else {
          // No "added after" (e.g. iCloud albums, listed by date taken): list the whole collection and remember refs, so
          // a photo added to an album is found wherever it sits. At most every 5 minutes; the first look is a baseline.
          // (A cursor from before full scans only knew the newest photos: its first full scan is a baseline too.)
          const first = !cur.listed || !cur.scannedAt;
          if (!first && cur.scannedAt && Date.now() - Date.parse(cur.scannedAt) < FULL_SCAN_EVERY_S * 1000) continue;
          let cursor: string | null = null;
          for (let page = 0; page < FULL_SCAN_PAGES; page++) {
            const r = await vault.query(src.source, { limit: 100, ...collection, ...(cursor ? { cursor } : {}) });
            await insert(r.items.map((i) => i.ref), first ? "baseline" : "pending");
            cursor = r.cursor;
            if (!cursor) break;
          }
          cursors[k] = { listed: true, scannedAt: new Date().toISOString() };
        }
      }
    } catch (e) {
      error = e instanceof HttpError ? e.code : "internal";
      if (error === "internal") log(e, "workflow discovery failed");
    }
    await ctx.db.query("UPDATE workflows SET cursors = $2, last_check_at = now(), last_error = $3 WHERE id = $1", [w.id, JSON.stringify(cursors), error]);
  }
}

async function advance(ctx: Ctx, deps: AutomationDeps, log: (e: unknown, msg: string) => void) {
  const auto = automation(ctx, deps);
  const chars = characterStore(ctx);
  const notify = notifier(ctx);
  const tell = (r: RunRow, status: "done" | "failed") => { notify.forWorkflowRun(r.owner_sub, r.workflow_id, status).catch((e) => log(e, "notification failed")); };
  const { rows } = await ctx.db.query<RunRow & { data: string; active: boolean }>(
    `SELECT r.*, w.data, w.active FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id JOIN automation a ON a.owner_sub = r.owner_sub
     WHERE r.status IN ('pending', 'running') ORDER BY r.created_at LIMIT 200`,
  );
  const inFlight = new Map<string, number>();
  for (const r of rows) if (r.job_id) inFlight.set(r.workflow_id, (inFlight.get(r.workflow_id) ?? 0) + 1);
  const revoked = new Set<string>();

  for (const r of rows) {
    if (revoked.has(r.owner_sub)) continue;
    const set = (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields);
      return ctx.db.query(
        `UPDATE workflow_runs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
        [r.id, ...keys.map((k) => (k === "notes" ? JSON.stringify(fields[k]) : fields[k]))],
      );
    };
    const fail = async (code: string) => { await set({ status: "failed", failure: code, job_id: null }); tell(r, "failed"); };
    try {
      const d = openRow<WorkflowData>(ctx.sealer, r.workflow_id, r.data);
      const steps = stepsOf(d);
      const vault = (await auto.vaultFor(r.owner_sub))!;

      if (!r.job_id) {
        if (!r.active) continue; // paused: waits
        if ((inFlight.get(r.workflow_id) ?? 0) >= IN_FLIGHT_PER_WORKFLOW) continue;
        let item = r.item_id;
        if (!item) {
          item = (await vault.stage(r.source, r.ref)).id;
          await set({ item_id: item, status: "running" });
        }
        if (r.step >= steps.length) { await set({ status: "done" }); tell(r, "done"); continue; }
        const step = steps[r.step]!;
        const image = await vault.content(item);
        const extra = { workflowRunId: r.id, summary: { title: `${d.name} · ${STEP_TITLES[step.op]}`, workflow: d.name } };
        let jobId: string;
        if (step.op === "face_swap") {
          const cs = [];
          for (const id of step.characters) cs.push(await chars.load(r.owner_sub, id));
          jobId = await faceSwapJob(ctx, r.owner_sub, image, cs, extra);
        } else if (step.op === "upscale") {
          jobId = await upscaleJob(ctx, r.owner_sub, image, step.scale, extra);
        } else {
          jobId = await imageJob(ctx, r.owner_sub, step.op, image, step.strength, extra);
        }
        await set({ job_id: jobId, status: "running" });
        inFlight.set(r.workflow_id, (inFlight.get(r.workflow_id) ?? 0) + 1);
        continue;
      }

      const { rows: js } = await ctx.db.query<{ status: string; failure_code: string | null; job_key: string | null; format: string | null }>(
        "SELECT j.status, j.failure_code, j.job_key, (SELECT format FROM job_results WHERE job_id = j.id AND n = 1) AS format FROM jobs j WHERE j.id = $1",
        [r.job_id],
      );
      const job = js[0];
      const step = steps[r.step];
      if (!job || !step || ["cancelled", "expired"].includes(job.status)) { await fail("cancelled"); continue; }
      if (job.status === "queued" || job.status === "running") continue;
      if (job.status === "failed") {
        if (job.failure_code === "no_face_found" && step.op === "face_swap") {
          // Nothing to swap in this image: keep it as it is and go on.
          await set({ step: r.step + 1, job_id: null, notes: [...r.notes, "no_face_found"] });
          await purgeJob(ctx, r.job_id);
          await ctx.db.query("DELETE FROM jobs WHERE id = $1", [r.job_id]);
        } else {
          await fail(job.failure_code ?? "failed");
        }
        continue;
      }
      // done: the result becomes the item's next version, the job is removed (the vault now holds the image).
      const result = await readResult(ctx, r.job_id, 1, job.job_key);
      const fmt = detectFormat(result) ?? "png";
      await vault.addVersion(r.item_id!, result, contentType(fmt), step.op, d.name.slice(0, 200));
      await purgeJob(ctx, r.job_id);
      await ctx.db.query("DELETE FROM jobs WHERE id = $1", [r.job_id]);
      const next = r.step + 1;
      await set({ step: next, job_id: null, status: next >= steps.length ? "done" : "running" });
      if (next >= steps.length) tell(r, "done");
      inFlight.set(r.workflow_id, Math.max(0, (inFlight.get(r.workflow_id) ?? 1) - 1));
    } catch (e) {
      if (e instanceof VaultError && e.status === 401) {
        revoked.add(r.owner_sub);
        await ctx.db.query("UPDATE workflows SET last_error = 'automation_revoked' WHERE owner_sub = $1 AND active", [r.owner_sub]);
        continue;
      }
      if (e instanceof VaultError && (e.status === 503 || e.status >= 500 && e.code === "vault_unavailable")) continue; // try again next tick
      const code = e instanceof HttpError ? e.code : "internal";
      if (code === "internal") log(e, "workflow step failed");
      await fail(code);
    }
  }
}
