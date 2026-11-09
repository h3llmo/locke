import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { ZodError } from "zod";
import { createDb, env, HttpError, migrate, retry, Sealer, secret } from "@ilven/common";
import { mountMcp, McpServer } from "@ilven/common/mcp";
import { migrations } from "./db.ts";
import { ObjectStore } from "./store.ts";
import { registerWithNevli, storageFromNevli } from "./nevli.ts";
import { expireJobs, reapLeases, SETTINGS, type Ctx } from "./jobs.ts";
import { registerWorkerApi } from "./worker-api.ts";
import { API_PREFIX, registerApi } from "./api.ts";
import { runSchedules } from "./prompts.ts";
import { runWorkflows, type AutomationDeps } from "./automation.ts";

/**
 * Locke server: the web app under /apps/locke/ (Ilven gateway → container alias app-locke:8080), Locke's API, the
 * GPU worker API (docs/worker-api.md), and an MCP endpoint for Ilven-AI on the internal port 8081.
 */
const PREFIX = "/apps/locke";
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "web");

const masterKey = secret("LOCKE_MASTER_KEY");
const appSecret = secret("LOCKE_APP_SECRET");
const nevliUrl = env("NEVLI_INTERNAL_URL", "http://nevli:3001");
const db = createDb();
await retry("database", () => db.query("SELECT 1"));
await migrate(db, migrations);

await registerWithNevli(nevliUrl, appSecret, env("LOCKE_MCP_URL", "http://app-locke:8081/mcp"));
const store = new ObjectStore(await storageFromNevli(nevliUrl, appSecret));
const ctx: Ctx = { db, store, sealer: new Sealer(masterKey) };

function errors(app: FastifyInstance) {
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof HttpError) {
      const extra = (e as HttpError & { extra?: Record<string, unknown> }).extra ?? {};
      return reply.status(e.status).send({ error: e.code, message: e.message, ...extra });
    }
    if (e instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_body", message: "Invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 413) return reply.status(413).send({ error: "too_large", message: "Too large" });
    if (status === 415) return reply.status(415).send({ error: "unsupported_media_type", message: (e as Error).message });
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (e as Error).message });
    req.log.error({ err: e }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "Internal error" });
  });
}

const logger = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-locke-lease\"]"], censor: "[redacted]" },
};
const app = Fastify({ logger, trustProxy: true, bodyLimit: 1024 * 1024 });
errors(app);
app.get("/healthz", { logLevel: "silent" }, async () => ({ ok: true }));
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  return payload;
});
await app.register(fastifyMultipart, { limits: { fileSize: SETTINGS.maxInputBytes, files: 1 + 4 * 8 + 4, fields: 4, parts: 44 } });

// Character photos are uploaded one by one as the raw body.
app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: SETTINGS.maxInputBytes }, (_req, body, done) => done(null, body));

const deps: AutomationDeps = {
  nevliUrl, appSecret, vaultUrl: env("LOCKE_VAULT_URL", "http://app-locke-vault:8080/apps/locke-vault/api"),
};
registerWorkerApi(app, ctx, masterKey);
registerApi(app, ctx, masterKey, deps);
app.all(`${API_PREFIX}/*`, async (_req, reply) => reply.status(404).send({ error: "not_found", message: "Not found" }));

await app.register(fastifyStatic, {
  root: webRoot,
  prefix: `${PREFIX}/`,
  index: false,
  wildcard: false,
  // Hashed build assets never change; everything else (index.html, manifest) is revalidated.
  cacheControl: false,
  setHeaders: (res, path) => { res.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"); },
});
app.get(PREFIX, (_req, reply) => reply.redirect(`${PREFIX}/`));

// Single-page app: hashed assets are immutable; every other path under the prefix gets index.html.
app.get(`${PREFIX}/*`, (req, reply) => {
  const rel = (req.params as { "*": string })["*"];
  if (rel && !rel.includes("..") && existsSync(join(webRoot, rel))) return reply.sendFile(rel);
  if (/\.[a-z0-9]{2,5}$/i.test(rel)) return reply.code(404).send({ error: "not_found", message: "Not found" });
  return reply.sendFile("index.html");
});

// MCP for Ilven-AI (internal port, never routed by the gateway). Tools come with Locke's MCP step; registering the
// endpoint now lets Nevli list Locke with an empty default preset.
const mcp = Fastify({ logger, bodyLimit: 1024 * 1024 });
errors(mcp);
mountMcp(mcp, "/mcp", () => new McpServer({ name: "locke", version: "0.1.0" }, { capabilities: { tools: {} } }));

// Housekeeping: expired leases go back to the queue; unkept results are deleted after their keep date.
setInterval(() => void reapLeases(ctx).catch((e) => app.log.error({ err: e }, "lease reaper failed")), 5000).unref();
setInterval(() => void expireJobs(ctx).catch((e) => app.log.error({ err: e }, "expiry failed")), 10 * 60 * 1000).unref();
// Schedules (saved prompts) and automated workflows.
setInterval(() => void runSchedules(ctx, (e) => app.log.error({ err: e }, "schedule run failed")).catch((e) => app.log.error({ err: e }, "scheduler failed")), 20_000).unref();
setInterval(() => void runWorkflows(ctx, deps, (e, msg) => app.log.error({ err: e }, msg)).catch((e) => app.log.error({ err: e }, "workflow engine failed")), 20_000).unref();

await mcp.listen({ host: "0.0.0.0", port: 8081 });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
