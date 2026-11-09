import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { err, jobEvents, type Ctx } from "./jobs.ts";

/**
 * Notifications to the user's own Discord channel (an incoming webhook they create). Messages are generic on purpose:
 * no prompt, no image, no character or workflow name leaves Locke, only "results are ready" and a link back.
 * Test jobs never notify; workflow steps notify once per finished image (from the workflow engine).
 */
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

type Lang = "en" | "fr";
const TEXT: Record<Lang, Record<string, (n: number) => string>> = {
  en: {
    generate: (n) => (n > 1 ? `${n} images are ready` : "Your image is ready"),
    face_swap: () => "Your face swap is ready",
    enhance: () => "Your enhanced image is ready",
    blur: () => "Your blurred image is ready",
    scheduled: (n) => (n > 1 ? `Scheduled run: ${n} images are ready` : "Scheduled run: your image is ready"),
    failed: () => "A job failed",
    workflowDone: () => "A workflow finished an image (saved in your vault)",
    workflowFailed: () => "A workflow couldn't finish an image",
    test: () => "Notifications from Locke work",
  },
  fr: {
    generate: (n) => (n > 1 ? `${n} images sont prêtes` : "Votre image est prête"),
    face_swap: () => "Votre échange de visage est prêt",
    enhance: () => "Votre image améliorée est prête",
    blur: () => "Votre image floutée est prête",
    scheduled: (n) => (n > 1 ? `Exécution planifiée : ${n} images sont prêtes` : "Exécution planifiée : votre image est prête"),
    failed: () => "Une tâche a échoué",
    workflowDone: () => "Un workflow a terminé une image (enregistrée dans votre coffre)",
    workflowFailed: () => "Un workflow n'a pas pu terminer une image",
    test: () => "Les notifications de Locke fonctionnent",
  },
};
const OPEN: Record<Lang, string> = { en: "Open", fr: "Ouvrir" };

interface Row { owner_sub: string; discord_webhook: string; notify_failures: boolean; app_url: string; lang: Lang }

export function notifier(ctx: Ctx) {
  const settings = async (sub: string) =>
    (await ctx.db.query<Row>("SELECT * FROM notifications WHERE owner_sub = $1", [sub])).rows[0] ?? null;

  /** Posts one message. Returns an error code, or null when Discord accepted it. */
  const post = async (r: Row, key: string, n: number, path: string): Promise<string | null> => {
    const lang: Lang = r.lang === "fr" ? "fr" : "en";
    const text = TEXT[lang][key]!(n);
    const link = `${r.app_url.replace(/\/$/, "")}${path}`;
    let code: string | null = null;
    try {
      const res = await fetch(ctx.sealer.open(r.discord_webhook), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "Locke", content: `**Locke** · ${text}\n${OPEN[lang]}: <${link}>`, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!res.ok) code = res.status === 404 || res.status === 401 ? "webhook_gone" : `discord_${res.status}`;
    } catch {
      code = "discord_unreachable";
    }
    await ctx.db.query(
      `UPDATE notifications SET last_error = $2, last_sent_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_sent_at END WHERE owner_sub = $1`,
      [r.owner_sub, code],
    );
    return code;
  };

  const forJob = async (jobId: string, status: "done" | "failed") => {
    const { rows } = await ctx.db.query<{ owner_sub: string; type: string; is_test: boolean; workflow_run_id: string | null; schedule_id: string | null; result_count: number | null }>(
      "SELECT owner_sub, type, is_test, workflow_run_id, schedule_id, result_count FROM jobs WHERE id = $1",
      [jobId],
    );
    const j = rows[0];
    if (!j || j.is_test || j.workflow_run_id) return;
    const r = await settings(j.owner_sub);
    if (!r || (status === "failed" && !r.notify_failures)) return;
    const key = status === "failed" ? "failed" : j.schedule_id && j.type === "generate" ? "scheduled" : j.type;
    await post(r, key, j.result_count ?? 1, `/jobs/${jobId}`);
  };

  const forWorkflowRun = async (sub: string, workflowId: string, status: "done" | "failed") => {
    const r = await settings(sub);
    if (!r || (status === "failed" && !r.notify_failures)) return;
    await post(r, status === "done" ? "workflowDone" : "workflowFailed", 1, `/automate/${workflowId}`);
  };

  return { settings, post, forJob, forWorkflowRun };
}

/** Listens for finished jobs. Failures to notify never affect the job. */
export function startNotifications(ctx: Ctx, log: (e: unknown) => void) {
  const n = notifier(ctx);
  jobEvents.on("finished", (jobId: string, status: "done" | "failed") => { n.forJob(jobId, status).catch(log); });
}

export function registerNotificationApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: (req: FastifyRequest) => Promise<{ sub: string }>) {
  const n = notifier(ctx);
  const view = (r: (Row & { last_sent_at: Date | null; last_error: string | null }) | null) => ({
    discord: r ? { configured: true, notifyFailures: r.notify_failures, lastSentAt: r.last_sent_at, lastError: r.last_error } : { configured: false },
  });
  const full = async (sub: string) =>
    (await ctx.db.query<Row & { last_sent_at: Date | null; last_error: string | null }>("SELECT * FROM notifications WHERE owner_sub = $1", [sub])).rows[0] ?? null;

  app.get(`${prefix}/notifications`, async (req) => view(await full((await auth(req)).sub)));

  // The webhook URL is write-only: it's never sent back. Leave it out to change only the options.
  app.put(`${prefix}/notifications/discord`, async (req) => {
    const c = await auth(req);
    const b = z.object({
      webhookUrl: z.string().trim().max(400).optional(),
      notifyFailures: z.boolean().default(true),
      appUrl: z.url().max(300).refine((u) => /^https?:\/\//.test(u), "http(s) only"),
      lang: z.enum(["en", "fr"]).default("en"),
    }).parse(req.body);
    const cur = await full(c.sub);
    if (b.webhookUrl !== undefined && !WEBHOOK.test(b.webhookUrl)) throw err(400, "invalid_webhook", "Paste a Discord webhook URL (https://discord.com/api/webhooks/…)");
    if (!cur && !b.webhookUrl) throw err(400, "invalid_webhook", "Paste a Discord webhook URL first");
    const sealed = b.webhookUrl ? ctx.sealer.seal(b.webhookUrl) : cur!.discord_webhook;
    await ctx.db.query(
      `INSERT INTO notifications (owner_sub, discord_webhook, notify_failures, app_url, lang) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_sub) DO UPDATE SET discord_webhook = $2, notify_failures = $3, app_url = $4, lang = $5,
         last_error = CASE WHEN $6 THEN NULL ELSE notifications.last_error END`,
      [c.sub, sealed, b.notifyFailures, b.appUrl, b.lang, !!b.webhookUrl],
    );
    return view(await full(c.sub));
  });

  app.delete(`${prefix}/notifications/discord`, async (req) => {
    const c = await auth(req);
    await ctx.db.query("DELETE FROM notifications WHERE owner_sub = $1", [c.sub]);
    return view(null);
  });

  app.post(`${prefix}/notifications/discord/test`, async (req) => {
    const c = await auth(req);
    const r = await n.settings(c.sub);
    if (!r) throw err(409, "not_configured", "Add a Discord webhook first");
    const code = await n.post(r, "test", 1, "/settings");
    if (code) throw err(502, code, code === "webhook_gone" ? "Discord says this webhook doesn't exist any more" : "Discord didn't accept the message");
    return view(await full(c.sub));
  });
}
