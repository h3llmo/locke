import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "@ilven/common";
import { McpServer, toolResult } from "@ilven/common/mcp";
import { API_PREFIX } from "./api.ts";
import { err } from "./jobs.ts";
import type { EditView } from "./edits.ts";

/**
 * Locke's tools for Ilven-AI (CLAUDE.md §4.3, §5.4). Ilven-AI calls them through the user's connex with the user's own
 * Ilven API key; only the tools in the user's preset are ever offered or run (enforced by Ilven-AI). Every tool goes
 * through Locke's own REST API in-process, with that same key, so the assistant gets exactly the checks the app has:
 * nothing here can do more than the user can do in Locke's UI. Delegated keys (workflows) are refused by the API.
 *
 * Results are summaries for the model: ids, statuses and names, never image bytes.
 */
type Res = { status: number; json: unknown; raw: Buffer; type: string };

export function createLockeMcp(app: FastifyInstance, vaultUrl: string) {
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const key = typeof header === "string" && /^Bearer ilv_[A-Za-z0-9_-]{10,200}$/.test(header) ? header : null;

    /** One call to Locke's REST API as the user. Errors become tool errors with the API's own message. */
    const call = async (method: string, path: string, body?: { json?: unknown; form?: FormData }): Promise<Res> => {
      if (!key) throw err(401, "unauthorized", "An Ilven API key is required");
      let payload: Buffer | string | undefined;
      const headers: Record<string, string> = { authorization: key };
      if (body?.json !== undefined) { payload = JSON.stringify(body.json); headers["content-type"] = "application/json"; }
      if (body?.form) {
        const r = new Request("http://locke/", { method: "POST", body: body.form });
        payload = Buffer.from(await r.arrayBuffer());
        headers["content-type"] = r.headers.get("content-type")!;
      }
      const res = await app.inject({ method: method as "GET", url: `${API_PREFIX}${path}`, headers, ...(payload !== undefined ? { payload } : {}) });
      const type = String(res.headers["content-type"] ?? "");
      const json = type.includes("json") ? (res.json() as unknown) : null;
      if (res.statusCode >= 400) {
        const e = json as { error?: string; message?: string } | null;
        throw new HttpError(res.statusCode, e?.error ?? "error", e?.message ?? `Locke answered HTTP ${res.statusCode}`);
      }
      return { status: res.statusCode, json, raw: res.rawPayload, type };
    };
    const get = async <T>(path: string) => (await call("GET", path)).json as T;
    const send = async <T>(method: string, path: string, json?: unknown) => (await call(method, path, json === undefined ? undefined : { json })).json as T;

    /** Locke Vault, with the same key (the vault accepts users' own API keys). */
    const vault = async (path: string, init: RequestInit = {}) => {
      if (!key) throw err(401, "unauthorized", "An Ilven API key is required");
      const res = await fetch(`${vaultUrl}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: key }, signal: AbortSignal.timeout(60_000) })
        .catch(() => { throw err(503, "vault_unavailable", "Locke Vault is not reachable"); });
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new HttpError(res.status, e?.error ?? "vault_error", e?.message ?? `Locke Vault answered HTTP ${res.status}`);
      }
      return res;
    };

    type Job = {
      id: string; type: string; status: string; summary: Record<string, unknown> | null; queuePosition: number | null; failureCode: string | null;
      resultCount: number | null; createdAt: string; finishedAt: string | null; expiresAt: string | null; scheduleId: string | null; workflow: boolean; kept: boolean; progress: unknown;
    };
    const brief = (j: Job) => ({
      id: j.id, type: j.type, status: j.status,
      title: (j.summary?.prompt as string | undefined) ?? (j.summary?.title as string | undefined) ?? j.type,
      ...(j.summary?.character ? { character: j.summary.character } : {}),
      ...(Array.isArray(j.summary?.names) ? { characters: j.summary.names } : {}),
      ...(j.summary?.vaultItem ? { vaultItem: j.summary.vaultItem } : {}),
      ...(j.queuePosition ? { queuePosition: j.queuePosition } : {}),
      ...(j.failureCode ? { failure: j.failureCode } : {}),
      ...(j.status === "done" ? { results: j.resultCount ?? 0, deletedAt: j.kept ? null : j.expiresAt } : {}),
      ...(j.scheduleId ? { scheduled: true } : {}), ...(j.workflow ? { workflow: true } : {}),
      createdAt: j.createdAt, finishedAt: j.finishedAt,
    });
    type Options = { generate: { styles: { id: string; label: string }[]; counts: number[]; character: boolean } | null; faceSwap: unknown; enhance: { strengths: string[] } | null; blur: unknown; upscale?: { scales: number[] } | null };

    const s = new McpServer({ name: "locke", version: "0.2.0" }, { capabilities: { tools: {} } });
    const ro = { readOnlyHint: true } as const;
    const act = { readOnlyHint: false, destructiveHint: false } as const;
    const destructive = { readOnlyHint: false, destructiveHint: true } as const;
    const id = z.string().min(1).max(64);

    // ---------- reading ----------
    s.registerTool("get_status", {
      title: "GPU status and options",
      description: "Whether Locke's GPU is online, the user's queued/running jobs, and what can be asked for right now (generation styles, image counts, face swap, enhance, upscale, blur).",
      inputSchema: {}, annotations: ro,
    }, async () => toolResult(async () => {
      const [w, o] = await Promise.all([get<{ status: string; queued: number; running: number }>("/worker-status"), get<Options>("/options")]);
      return {
        gpu: w.status, myJobs: { queued: w.queued, running: w.running },
        generate: o.generate ? { styles: o.generate.styles, counts: o.generate.counts, withCharacter: o.generate.character } : null,
        faceSwap: o.faceSwap, enhance: o.enhance, upscale: o.upscale ?? null, blur: !!o.blur, note: "Jobs wait in the queue while the GPU is offline; they run when it comes back.",
      };
    }));

    s.registerTool("list_jobs", {
      title: "List jobs",
      description: "The user's recent Locke jobs (generations; photo edits are listed by list_edits), newest first. Results that aren't saved to the vault are deleted after 7 days.",
      inputSchema: { limit: z.int().min(1).max(50).default(10), status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional() },
      annotations: ro,
    }, async ({ limit, status }) => toolResult(async () => {
      const { jobs } = await get<{ jobs: (Job & { test: boolean })[] }>(`/jobs?limit=${status ? 200 : limit + 10}`);
      return { jobs: jobs.filter((j) => !j.test && (!status || j.status === status)).slice(0, limit).map(brief) };
    }));

    s.registerTool("get_job", {
      title: "Get a job", description: "One job's status, progress and results count.", inputSchema: { id }, annotations: ro,
    }, async ({ id: jobId }) => toolResult(async () => {
      const j = await get<Job>(`/jobs/${encodeURIComponent(jobId)}`);
      return { ...brief(j), ...(j.status === "running" ? { progress: j.progress } : {}) };
    }));

    s.registerTool("list_characters", {
      title: "List characters", description: "The user's saved characters (people whose face Locke can put in images), with how many photos each has.",
      inputSchema: {}, annotations: ro,
    }, async () => toolResult(async () => {
      const { characters } = await get<{ characters: { id: string; name: string; gender: string; age: string; faces: unknown[] }[] }>("/characters");
      return { characters: characters.map((c) => ({ id: c.id, name: c.name, gender: c.gender, age: c.age, photos: c.faces.length })) };
    }));

    s.registerTool("list_saved_prompts", {
      title: "List saved prompts", description: "The user's saved prompts (ready-made generations) and their schedules.", inputSchema: {}, annotations: ro,
    }, async () => toolResult(async () => {
      const { prompts } = await get<{ prompts: { id: string; name: string; positive: { text: string; on: boolean }[]; style: string; count: number; character: string | null; references: unknown[]; schedule: { active: boolean; spec: unknown; nextRunAt: string | null; keepResults: boolean } | null }[] }>("/prompts");
      return {
        prompts: prompts.map((p) => ({
          id: p.id, name: p.name, prompt: p.positive.filter((f) => f.on).map((f) => f.text).join(", "), style: p.style, images: p.count,
          ...(p.character ? { character: p.character } : {}), ...(p.references.length ? { referencePhotos: p.references.length } : {}),
          schedule: p.schedule ? { active: p.schedule.active, repeat: p.schedule.spec, nextRunAt: p.schedule.nextRunAt, keepsResults: p.schedule.keepResults } : null,
        })),
      };
    }));

    s.registerTool("list_workflows", {
      title: "List workflows", description: "The user's automated workflows (steps applied to new images from their sources) and what they did lately.",
      inputSchema: {}, annotations: ro,
    }, async () => toolResult(async () => {
      const { workflows } = await get<{ workflows: { id: string; name: string; active: boolean; sources: { label: string }[]; steps: { op: string }[]; blur: unknown; lastError: string | null; stats: Record<string, unknown> }[] }>("/workflows");
      return {
        workflows: workflows.map((w) => ({
          id: w.id, name: w.name, active: w.active, sources: w.sources.map((x) => x.label), steps: [...w.steps.map((x) => x.op), ...(w.blur ? ["blur"] : [])],
          ...(w.lastError ? { problem: w.lastError } : {}), stats: w.stats,
        })),
      };
    }));

    s.registerTool("list_vault_photos", {
      title: "List vault photos", description: "Photos in the user's Locke Vault (PNG/JPEG), most recently changed first. Use their ids for face_swap.",
      inputSchema: { limit: z.int().min(1).max(50).default(20) }, annotations: ro,
    }, async ({ limit }) => toolResult(async () => {
      const r = (await (await vault(`/items?limit=60`)).json()) as { items: { id: string; title: string; versions: { contentType: string }[]; updatedAt: string }[] };
      const ok = r.items.filter((i) => /^image\/(png|jpeg)$/.test(i.versions[i.versions.length - 1]?.contentType ?? ""));
      return { photos: ok.slice(0, limit).map((i) => ({ id: i.id, title: i.title, versions: i.versions.length, updatedAt: i.updatedAt })) };
    }));

    // ---------- doing ----------
    s.registerTool("generate_images", {
      title: "Generate images",
      description: "Queue an image generation from a text prompt. Returns at once; the images are ready later (check with get_job). Unless the user says otherwise, use the first available style, portrait, 1 image, fast.",
      inputSchema: {
        prompt: z.string().trim().min(1).max(500).describe("What to show, in words"),
        avoid: z.string().trim().max(500).optional().describe("What not to show"),
        style: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional().describe("Style id from get_status"),
        aspect: z.enum(["square", "portrait", "landscape"]).default("portrait"),
        count: z.int().min(1).max(4).default(1),
        quality: z.enum(["fast", "quality"]).default("fast"),
        character: id.optional().describe("Character id from list_characters, to put that person in the image"),
      },
      annotations: act,
    }, async (a) => toolResult(async () => {
      let style = a.style;
      if (!style) {
        const o = await get<Options>("/options");
        style = o.generate?.styles[0]?.id;
        if (!style) throw err(409, "no_generation", "No GPU offers image generation right now");
      }
      const form = new FormData();
      form.set("params", JSON.stringify({
        type: "generate", positive: [a.prompt], negative: a.avoid ? [a.avoid] : [], style, aspect: a.aspect, count: a.count, mode: a.quality,
        ...(a.character ? { character: a.character } : {}),
      }));
      return brief((await call("POST", "/jobs", { form })).json as Job);
    }));

    const briefEdit = (e: EditView) => ({
      id: e.id, kind: "edit", status: e.status, steps: e.steps.map((x) => x.op), step: e.status === "running" ? e.step + 1 : null,
      ...(e.current ? { gpu: e.current.status, queuePosition: e.current.queuePosition } : {}),
      ...(e.notes.length ? { skipped: e.notes } : {}), ...(e.failure ? { failure: e.failure } : {}),
      ...(e.status === "done" ? { result: e.result, deletedAt: e.expiresAt } : {}), createdAt: e.createdAt,
    });

    s.registerTool("edit_photo", {
      title: "Edit a vault photo",
      description: "Run one or more edits on one photo of the user's vault, in the given order, as a single edit: face_swap (with character ids from list_characters, matched by gender and age), enhance (faces only; strength subtle|balanced|strong, default balanced), upscale (scale 2 or 4, about 40 megapixels at most) and blur (background blur, strength 0-100, default 60). A step that finds no face is skipped. Only the final result is kept; save_result_to_vault adds it as one new version of the photo.",
      inputSchema: {
        photo: z.uuid().describe("Vault photo id (list_vault_photos, or the photo open in the editor)"),
        steps: z.array(z.discriminatedUnion("op", [
          z.object({ op: z.literal("face_swap"), characters: z.array(id).min(1).max(4) }),
          z.object({ op: z.literal("enhance"), strength: z.enum(["subtle", "balanced", "strong"]).default("balanced") }),
          z.object({ op: z.literal("upscale"), scale: z.union([z.literal(2), z.literal(4)]).default(2) }),
          z.object({ op: z.literal("blur"), strength: z.int().min(0).max(100).default(60) }),
        ])).min(1).max(6).describe("In order; e.g. [{op:'upscale',scale:2},{op:'blur',strength:60}]"),
      },
      annotations: act,
    }, async ({ photo, steps }) => toolResult(async () => {
      const res = await vault(`/items/${encodeURIComponent(photo)}/content`);
      const type = res.headers.get("content-type") ?? "";
      if (!/^image\/(png|jpeg)/.test(type)) throw err(415, "unsupported_image", "That vault file isn't a PNG or JPEG photo");
      const form = new FormData();
      form.set("params", JSON.stringify({ image: "photo", steps, vaultItem: photo }));
      form.set("photo", new Blob([await res.arrayBuffer()], { type }), "photo");
      return briefEdit((await call("POST", "/edits", { form })).json as EditView);
    }));

    s.registerTool("list_edits", {
      title: "List edits",
      description: "The user's recent edits of photos (Editor or edit_photo), newest first, with their steps and status. Unsaved results are deleted after 7 days.",
      inputSchema: { limit: z.int().min(1).max(50).default(10) }, annotations: ro,
    }, async ({ limit }) => toolResult(async () => ({ edits: (await get<{ edits: EditView[] }>(`/edits?limit=${limit}`)).edits.map(briefEdit) })));

    s.registerTool("run_saved_prompt", {
      title: "Run a saved prompt", description: "Queue one run of a saved prompt now (list_saved_prompts).", inputSchema: { id }, annotations: act,
    }, async ({ id: promptId }) => toolResult(async () => {
      const { jobId } = await send<{ jobId: string }>("POST", `/prompts/${encodeURIComponent(promptId)}/run`);
      return brief(await get<Job>(`/jobs/${encodeURIComponent(jobId)}`));
    }));

    s.registerTool("save_result_to_vault", {
      title: "Save a result to the vault",
      description: "Keep one finished result (a job's, or an edit's final image) in the user's Locke Vault (encrypted). An edit of a vault photo becomes one new version of that photo; anything else becomes a new vault photo.",
      inputSchema: { job: id.describe("A job id, or an edit id (ed_…)"), result: z.int().min(1).max(4).default(1).describe("Which result of the job (1 = first)") },
      annotations: act,
    }, async ({ job, result }) => toolResult(async () => {
      if (job.startsWith("ed_")) {
        const e = await get<EditView>(`/edits/${encodeURIComponent(job)}`);
        if (e.status !== "done") throw err(409, "not_done", "That edit has no result yet");
        const img = await call("GET", `/edits/${encodeURIComponent(job)}/images/result`);
        const body = new Uint8Array(img.raw);
        if (e.vaultItem) {
          try {
            await vault(`/items/${encodeURIComponent(e.vaultItem)}/versions?${new URLSearchParams({ app: "locke", operation: e.operation })}`, { method: "POST", headers: { "content-type": img.type }, body });
            return { saved: "new_version", photo: e.vaultItem };
          } catch (x) {
            if (!(x instanceof HttpError && x.status === 404)) throw x;
          }
        }
        const r = (await (await vault(`/items?${new URLSearchParams({ title: `Edit · ${e.steps.map((x) => x.op).join(", ")}`, app: "locke" })}`, { method: "POST", headers: { "content-type": img.type }, body })).json()) as { id: string };
        return { saved: "new_photo", photo: r.id };
      }
      const j = await get<Job>(`/jobs/${encodeURIComponent(job)}`);
      if (j.status !== "done") throw err(409, "not_done", "That job has no results yet");
      const img = await call("GET", `/jobs/${encodeURIComponent(job)}/results/${result}`);
      const body = new Uint8Array(img.raw);
      const vaultItem = j.summary?.vaultItem as string | undefined;
      if (vaultItem) {
        try {
          await vault(`/items/${encodeURIComponent(vaultItem)}/versions?${new URLSearchParams({ app: "locke", operation: j.type })}`, { method: "POST", headers: { "content-type": img.type }, body });
          return { saved: "new_version", photo: vaultItem };
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e; // trashed meanwhile: keep it as a new photo
        }
      }
      const title = `${String(j.summary?.prompt ?? j.summary?.title ?? "Locke").slice(0, 180)} · ${result}`;
      const r = (await (await vault(`/items?${new URLSearchParams({ title, app: "locke" })}`, { method: "POST", headers: { "content-type": img.type }, body })).json()) as { id: string };
      return { saved: "new_photo", photo: r.id };
    }));

    s.registerTool("set_schedule_active", {
      title: "Pause or resume a schedule", description: "Pause or resume the schedule of a saved prompt (list_saved_prompts).",
      inputSchema: { prompt: id, active: z.boolean() }, annotations: act,
    }, async ({ prompt, active }) => toolResult(async () => {
      const { prompts } = await get<{ prompts: { id: string; schedule: { spec: unknown; keepResults: boolean } | null }[] }>("/prompts");
      const p = prompts.find((x) => x.id === prompt);
      if (!p) throw err(404, "prompt_not_found", "Prompt not found");
      if (!p.schedule) throw err(409, "no_schedule", "This prompt has no schedule");
      const r = await send<{ schedule: { active: boolean; nextRunAt: string | null } }>("PUT", `/prompts/${encodeURIComponent(prompt)}/schedule`, { spec: p.schedule.spec, active, keepResults: p.schedule.keepResults });
      return { active: r.schedule.active, nextRunAt: r.schedule.nextRunAt };
    }));

    s.registerTool("set_workflow_active", {
      title: "Turn a workflow on or off", description: "Turn an automated workflow on (it handles images that arrive from now on) or off.",
      inputSchema: { workflow: id, active: z.boolean() }, annotations: act,
    }, async ({ workflow, active }) => toolResult(async () => {
      const w = await send<{ id: string; active: boolean }>("PATCH", `/workflows/${encodeURIComponent(workflow)}`, { active });
      return { id: w.id, active: w.active };
    }));

    s.registerTool("cancel_job", {
      title: "Cancel a job or edit", description: "Cancel a queued or running job, or an edit in progress (ed_…). Its images are deleted; this can't be undone.",
      inputSchema: { id }, annotations: destructive,
    }, async ({ id: jobId }) => toolResult(async () => jobId.startsWith("ed_")
      ? briefEdit(await send<EditView>("POST", `/edits/${encodeURIComponent(jobId)}/cancel`))
      : brief(await send<Job>("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`))));

    s.registerTool("delete_job", {
      title: "Delete a job or edit", description: "Delete a job or an edit (ed_…) and its results (copies saved to the vault are kept). This can't be undone.",
      inputSchema: { id }, annotations: destructive,
    }, async ({ id: jobId }) => toolResult(async () => {
      await call("DELETE", jobId.startsWith("ed_") ? `/edits/${encodeURIComponent(jobId)}` : `/jobs/${encodeURIComponent(jobId)}`);
      return { deleted: jobId };
    }));

    return s;
  };
}
