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
- **Ilven assistant**: the platform's assistant button on every page, with page context (current page, the photo open in
  the editor, chosen characters); lists reload after it acts. Locke's MCP (internal port 8081) offers 15 tools that call
  Locke's own REST API in-process with the user's own Ilven API key, so the assistant has exactly the user's rights:
  get_status, list_jobs, get_job, list_characters, list_saved_prompts, list_workflows, list_vault_photos,
  generate_images, face_swap (a vault photo), run_saved_prompt, save_result_to_vault, set_schedule_active,
  set_workflow_active, cancel_job and delete_job (both destructive: confirmed in the chat). Like every Ilven app, the
  default preset is empty: an Ilven admin allows tools in Nevli-Web.
- **Upscale** (workflow step ×2/×4, worker API §5.7 draft): offered once a GPU announces `upscale`; JPEG results of up
  to 40 MP.
- Workflows on sources without "new since" (iCloud albums) list the whole collection every 5 minutes and remember what
  they saw, so a photo added to an album is picked up whatever its date. Each ticked iCloud album (and Favorites,
  Hidden) is its own collection: one workflow per album.
- **Editor: background blur** (strength 0–100) next to face swap, on an uploaded or vault photo; keeping a vault photo's
  result adds a version (undo in the vault). Also an assistant tool (`blur_background`).
- Not yet: Enhance/Upscale in the Editor, push notifications.
