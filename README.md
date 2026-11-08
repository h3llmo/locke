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
Step 1 of the handoff (§10): app shell — tokens, fonts, dark/light/system theme, EN/FR messages, routes, dock
(< 640 px) / rail (640–1279) / sidebar (≥ 1280), assistant corner kept free, toasts, Settings (theme, language,
vault quota from Locke Vault, sign out). The Locke API, job queue, partner worker contract and MCP tools come next.
