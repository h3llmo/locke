# Locke — AI photo studio

Private, encrypted image creation and editing: generate from engineered prompts (now or on a schedule), enhance,
face-swap with recurring characters, blur backgrounds, and automate those steps on new images.
Locke is an **Ilven integration**: it runs inside an [Ilven](https://github.com/h3llmo/ilven) landing zone (single
sign-on, Locke Vault for encrypted image storage, Ilven-AI assistant). GPU work runs on a partner worker that pulls
jobs from Locke (later steps).

- Build spec: `docs/HANDOFF.md` (design handoff) and `CLAUDE.md` (rules). Design source files live on the
  `claude/locke-app-design-wwwu9c` branch history and in `docs/design/`.
- Stack: React 18 + Vite + TypeScript (web, `src/`), Fastify (server, `server/`), tokens in `src/styles/locke.css`.

## Run inside Ilven

Clone this repo next to Ilven (`../ilven`), then in the Ilven checkout:

```sh
# compose.local.yaml (untracked)
include:
  - ../locke/compose.yaml
# .env
COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.local.yaml
# Locke's results as a vault source (keep the default Pilot entry if you use Pilot)
VAULT_SOURCES=[{"id":"pilot","url":"http://app-pilot:8080/apps/pilot/api/vault-source"},{"id":"locke","url":"http://app-locke:8080/apps/locke/api/vault-source"}]
```

`docker compose up -d --build locke` → http://localhost:8080/apps/locke/. The image builds against Ilven's shared
browser auth (`@ilven/web-auth`) from the Ilven checkout (build context `ilven`, override with `ILVEN_REPO`).

## Develop

```sh
npm install          # links ../ilven/packages/web-auth
npm run typecheck
npm run build        # dist/web (app) + dist/index.mjs (server)
```

## Status
- **Create:** prompt fragments (list / raw, positive / negative), styles from the GPU, format, results, speed,
  references (upload or vault), a saved character when the GPU supports it. **Saved prompts** keep everything,
  including switched-off fragments and references. **Schedules** run a saved prompt every few minutes, hourly, daily
  or weekly (wall-clock, user's time zone); a run is skipped while the previous one still waits; results can be kept.
- **Jobs:** Recent and Scheduled tabs, result page (Keep to the vault, or as a new version of the vault image that was
  edited; Download; viewer; Run again).
- **Editor:** face swap of an uploaded or vault photo with saved characters.
- **Characters:** name, gender and age (which face is theirs), 1–8 photos, main face first. Sealed at rest.
- **Automate:** workflows watch vault sources (any collection, e.g. one schedule) and run Face swap / Enhance, then
  Blur last, on every new image; each step adds a version in the vault. They run while the user is away with a
  **delegated key** from Nevli (asked once, revocable in Ilven Account; valid only at locke-vault, dms and Locke's
  vault source, for that user). Enhance and Blur wait for a GPU that offers them.
- **Discord notifications** (Settings): the user's own channel webhook (sealed, write-only); generic messages with
  a link when a job is done or failed, one per finished workflow image. No prompt, image or name is sent.
- **Locke as a vault source** (`/api/vault-source`, contract `ilven-vault-source/1`): finished results; collections
  "All", "Created by hand" and one per schedule; supports `addedAfter`.
- GPU worker API `locke-worker/1`: [docs/worker-api.md](docs/worker-api.md).
- Tests: unit (`npm test`), `test/e2e.mjs` (queue and worker API) and `test/e2e-features.mjs` (characters, prompts,
  schedules, source, automation). Both use their own worker with values real workers don't announce, so live workers
  can stay live.
- Not yet: Locke's MCP tools for Ilven-AI, Enhance/Blur in the Editor, push notifications.
