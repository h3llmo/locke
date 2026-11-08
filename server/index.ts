import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

/**
 * Locke server. Serves the web app under /apps/locke/ (Ilven gateway → container alias app-locke:8080).
 * Later steps add the API (prompts, jobs queue, partner worker endpoints, characters, workflows) and the MCP
 * server for Ilven-AI.
 */
const PREFIX = "/apps/locke";
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "web");

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });

app.get("/healthz", async () => ({ ok: true }));

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  return payload;
});

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

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
