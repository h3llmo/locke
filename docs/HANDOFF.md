# Locke — design handoff for implementation

**Design canvas (source of truth for visuals):** https://claude.ai/artifact/6GBCTWq3Qq6zXuhfSQKVib
(private — the owner shares it from the canvas's Share menu). Exported screenshots may sit next to this file.

This document turns that canvas into a build spec for a **React 18 + Vite + TypeScript** front-end.
Read `CLAUDE.md` first for the non-negotiable rules.

---

## 0. What is in this repo

| Path | What it is |
|---|---|
| `src/styles/locke.css` | **Production-ready** design tokens (dark + light) and core component classes. Import once in `main.tsx`. |
| `docs/design/reference/*.dc.html` | Source of every canvas artboard. Treat as **visual reference only**: it uses a canvas runtime (`{{holes}}`, `<sc-for>`, `<sc-if>`, `<dc-import>`), not React. Copy spacing, structure and copy; do not copy the runtime syntax. |
| `docs/design/reference/canvas.json` | Board index (titles describe which state each board shows). |
| `docs/design/placeholders/*.svg` | Placeholder images used in the mockups (see §11 for the `/_blob/…` id → file mapping). Use them for dev fixtures/Storybook only. |

---

## 1. Product in one paragraph

Locke creates and edits images with AI. Every generation or edit is a **job** sent to a GPU worker on a
partner's side that may be busy or offline; jobs take seconds to minutes and can queue. Images live in
the user's **vault** (Locke Vault, encrypted, 256 MB quota), which also exposes read-only **sources**
(iCloud album, Documents, Generated, and each **scheduled prompt**). Users engineer **prompts**
(fragment list or raw text, positive/negative, references), run them now or on a **schedule**, edit images
with **Enhance / Face swap / Blur** (Edit = later), keep recurring **characters** (up to 8 face photos),
and set up **workflows** that apply edits automatically to new images from sources.

## 2. Information architecture & routes

| Area | Route | Mobile | Desktop |
|---|---|---|---|
| Create (prompt editor) | `/create`, `/create/:promptId` | `CreateMobile`, sheets `ScheduleMobile`, `ReferencesMobile` | `CreateDesktop` |
| Jobs | `/jobs?tab=recent\|scheduled`, `/jobs/:jobId`, `/jobs/:jobId/view/:variant` | `JobsMobile`, `JobResultMobile` (viewer + grid) | `JobsDesktop` (list + result panel) |
| Editor | `/editor` (picker), `/editor/:itemId` | `EditorPickMobile`, `EditorMobile` | `EditorPickDesktop`, `EditorDesktop` |
| Automate | `/automate`, `/automate/:workflowId` | `WorkflowsMobile`, `WorkflowEditMobile` | `WorkflowsDesktop` |
| Characters | `/characters`, `/characters/:id` | `CharactersMobile`, `CharacterEditMobile` (dialog) | `CharactersDesktop` (grid + panel) |
| Settings | `/settings` | `SettingsMobile` | `SettingsDesktop` |

Navigation shells (`MobileNav`, `DesktopSidebar`, `Layout` boards):
- **< 640 px** — floating bottom **dock** with 5 tabs (Create, Jobs, Editor, Automate, Characters). Only the
  active tab shows its label; others are icon-only with `aria-label`. Dock spans `left: 12px; right: 88px`.
  Settings is reached from the header. Jobs tab has a count badge (unseen results).
- **640–1023 px** — 72 px nav rail (icon + short label, labels may wrap).
- **≥ 1024 px** — 248 px sidebar: logo, 5 nav items, **job indicator card** ("2 running · 3 queued",
  GPU state, "2 schedules · next 07:00"), vault **ring**, Settings. Collapse to 72 px rail at 1024–1279.
- Global **job indicator** is visible everywhere (header pill on mobile, sidebar card on desktop) and
  links to Jobs.
- Every tab keeps its scroll position and drafts. Deep links open the exact job/item.

## 3. Design tokens (already in `src/styles/locke.css`)

Theme = `class="lk lk-dark"` (default) or `"lk lk-light"` on `<html>`; "System" listens to
`prefers-color-scheme`. Update `<meta name="theme-color">` (#0D1117 / #F3F5F8).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #0D1117 | #F3F5F8 | page |
| `--surface-1/2/3` | #131922 / #19202A / #222A35 | #FFFFFF / #ECEFF3 / #E0E5EB | cards / inputs / hover, tracks |
| `--border` / `--border-strong` / `--border-input` | #242D39 / #334050 / #5A6676 | #D6DCE3 / #BAC3CD / #84909C | input border ≥ 3:1 |
| `--text` / `--text-2` / `--text-3` | #EEF2F6 / #AEB8C4 / #8893A0 | #10151B / #414A55 / #5A6470 | all ≥ 4.5:1 on their surfaces |
| `--accent` (mint, "do") | #5EDCB0 on #06271C | #0E7A56 on #FFFFFF | primary buttons, switches, sliders, badges |
| `--info-*` (blue, "chosen / in progress") | border #4FA3D1, text #A9DCF7 | border #2F7DB3, text #185A86 | selected pills, running jobs, progress |
| `--success` / `--warning` / `--danger` | #5EDCB0 / #F0B866 / #FF8F85 | #1C7A4F / #8A5800 / #BF3328 | status only |

Type: display 32/40 & title-l 24/32 (Space Grotesk 600); title-m 20/28, title-s 17/24 (Inter 600);
body 15/22; body-s 13/18; label 13/16 (500); caption 12/16; overline 11/16 caps (only uppercase style).
**Inputs are 16 px** (prevents iOS zoom). Tabular numerals for counts, sizes, times.

Spacing 4-pt (4…64). Radius: 6, 8, 12, 16, 24, pill; buttons/chips/toasts are **pills**, cards 20,
tiles 14, sheets 24 top. Elevation e1/e2/e3 (dark relies on surface steps + border).
Motion: 120 / 200 / 320 ms; easings standard `(.2,0,0,1)`, enter `(.05,.7,.1,1)`, exit `(.3,0,.8,.15)`.
Reduced motion: slides/zooms → 120 ms crossfade; indeterminate bars static; skeleton shimmer off.

## 4. Components to build

Class names already exist in `locke.css`; wrap them in React components.

| Component | Class(es) | Notes / states |
|---|---|---|
| `Button` | `btn btn-primary/secondary/ghost/danger`, `btn-lg`, `btn-sm` (pointer only) | disabled, loading = label change, never spinner |
| `IconButton` | `icon-btn`, `on-image`, `is-on` | always `aria-label` |
| `Toolbar` | `toolbar` | grouped icon buttons (e.g. list/raw) |
| `OptionPills` (single/multi select) | `seg`, `seg-sm`, `chip`, `chip-sm`, `[aria-pressed]` | replaces selects/radios. Use with `opt-row` + `opt-label` ("Gender · Any Woman Man") |
| `Switch` | `switch is-on`, `role="switch"` | |
| `Slider` | `range`, `range-track/fill/thumb` | build on `<input type="range">` styled to match; arrow keys ±10 |
| `TextField` / `TextArea` | `input`, `is-error`, `hint`, `hint-error` | |
| `Tabs` (pill tabs) | `tabs` + `[aria-selected]` | horizontal scroll on mobile |
| `PromptFragmentList` | `toklist`, `tok`, `tok-num`, `tok-text`, `is-off`, `is-neg` | see §5.1 |
| `CharacterBubble` | `bubble`, `bubble-face`, `bubble-check`, `[aria-pressed]` | multi-select |
| `PresetCard` | `preset`, `is-on` | 4:5 thumbnail, label |
| `ImageTile` | `tile`, `tile-tag`, `is-on` | badges: "In vault", step count |
| `Pill` / `StatusPill` | `pill`, `pill-info/success/warning/danger/muted`, `dot`, `dot-hollow` | see §6 |
| `JobRow` | (layout in `JobsMobile`/`JobsDesktop`) | thumbnail = style/source image, **no preview** |
| `Progress` | `progress`, `progress-indet` | |
| `QuotaRing` | `ring` + inline `conic-gradient` | grey < 85 %, warning ≥ 85 %, danger at 100 %; `aria-label` with MB free |
| `Toast` | `toast` | inverse surface, pill, 5 s, one action, bottom-centre (mobile, above dock) / bottom-left (desktop) |
| `BottomSheet` | `sheet`, `grabber`, `scrim` | detents 45 % / 92 %, swipe down / scrim to dismiss, focus trap |
| `Dialog` | `dialog`, `scrim` | focus trap, Esc closes, returns focus |
| `CompareSlider` | `compare-line`, `compare-knob` | `role="slider"`, drag anywhere, ←/→ 10 %, Home/End |
| `HistoryStrip` | `version`, `is-on` | linear; see §5.3 |
| `FlowStep` | `flow`, `flow-step`, `flow-icon`, `flow-join` | workflow builder |
| `MobileDock`, `Sidebar`, `JobIndicator` | `dock` (`.dock-label`), `sidebar`, `nav-item`, `jobpill`, `badge-count` | |
| `AssistantSafeArea` | — | utility that reserves the 88 px corner; **do not render the assistant button** (the platform injects it — `.assist` in mockups is only for placement) |

Icons (24 viewBox, stroke paths; render with `<svg class="ic" viewBox="0 0 24 24"><path d="…"/></svg>`):

```
create      M12 3l1.8 4.9L19 9.7l-5.2 1.9L12 16.5l-1.8-4.9L5 9.7l5.2-1.8z M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z
jobs        M12 3 3 7.5 12 12l9-4.5L12 3z M3 12l9 4.5 9-4.5 M3 16.5 12 21l9-4.5
editor      M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6 M4 16l4-4 4 4 M17 3l4 4-7 7h-4v-4z
automate    M13 3 5 13h6l-1 8 8-10h-6z
characters  M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1 M16 3.5a4 4 0 0 1 0 7 M22 21v-1a6 6 0 0 0-4-5.6
lock        M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z M8 11V8a4 4 0 1 1 8 0v3
gpu         M7 7h10v10H7z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4
gpu-offline M9 2v4 M15 2v4 M7 6h10v4a5 5 0 0 1-10 0z M12 15v7
enhance     M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z
blur        M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18 M16 5v14 M20 9v6
face-swap   M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M13 6h4a2 2 0 0 1 2 2v3 M11 18H7a2 2 0 0 1-2-2v-3
edit-soon   M14 4l6 6-9 9H5v-6z M12 6l6 6
remove-blur M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3
keep        M4 5h16v4H4z M5 9v10h14V9 M12 12v5 M9.5 14.5 12 17l2.5-2.5
download    M12 4v11 M7 10l5 5 5-5 M5 20h14
delete      M4 7h16 M10 11v6 M14 11v6 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12 M9 7V4h6v3
retry       M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5
run-again   M4 12a8 8 0 0 1 14-5.3 M20 4v5h-5 M20 12a8 8 0 0 1-14 5.3 M4 20v-5h5
run-now     M7 4v16l13-8z
schedule    M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2
save-prompt M6 4h12v16l-6-4-6 4z
duplicate   M9 9h11v11H9z M5 15H4V4h11v1
flip-neg    M4 8h14 M14 4l4 4-4 4 M20 16H6 M10 12l-4 4 4 4
mode-list   M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01
mode-raw    M5 7h14 M5 12h14 M5 17h9
sort        M7 4v16 M4 17l3 3 3-3 M14 6h6 M14 12h4 M14 18h2
filter      M4 6h16 M7 12h10 M10 18h4
search      M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4
compare     M12 3v18 M8 6H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3 M16 6h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3
upload      M12 20V9 M7 14l5-5 5 5 M5 4h14
icloud      M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9z
folder      M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z
steps-count M8 8h12v12H8z M4 16V4h12
main-face   M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z   (filled)
crop        M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14
plus / close / check / back / chevron / more / info — standard (see Main.dc.html icon grid)
```

## 5. Screens

Each section lists the boards to match, the content, and the behaviours. Copy text is in the boards.

### 5.1 Create — prompt editor (`CreateMobile`, `ScheduleMobile`, `ReferencesMobile`, `CreateDesktop`)
- **Prompt card**: header toolbar [List | Raw] mode toggle, "n / total" enabled count, **flip to negative**,
  overflow (save, duplicate, clear). Pills "Positive · 9" / "Negative · 5" switch the side being edited.
  Small lock caption "Private".
- **List mode** = the prompt split on commas into fragments: numbered circle (blue), text, **switch** to
  include/exclude (excluded → struck-through, muted). Tap text to edit in place; drag (long-press on mobile)
  to reorder; "Add fragment". Negative fragments use a danger-coloured number ring.
- **Raw mode** = the same fragments joined with ", " in a textarea; editing re-splits on commas.
  Disabled fragments are omitted from the raw text but kept in the model (show them when returning to list).
- **Saved prompts** (desktop left column; mobile bookmark button → sheet): name, first fragments, schedule
  pill ("Daily 07:00", "Every hour · paused"). Selecting loads it; edits mark it dirty; Save names/overwrites.
- **Settings as compact selectors** (mobile: one horizontal row of chips; desktop: right column):
  Style (preset thumbnails, 6–20 presets, "All 14" opens full grid), Character (bubbles, single select,
  "None"), References (0–4 thumbnails + add → `ReferencesMobile`: Vault / Generated / iCloud tabs, numbered
  selection order, upload), Format (Square/Portrait/Landscape), Results (1–4), Mode (Fast/Best).
- **Actions**: `Schedule` (secondary) + `Run now` (primary). Run now → toast "Queued · 3rd in line · View";
  form keeps values; focus stays in the prompt; Ctrl/⌘+Enter runs.
- **Schedule sheet**: name (prefilled from prompt name), Repeat [Every minute | Hourly | Daily | Weekly],
  time(s) for daily/weekly, summary of what each run uses, switch "Keep results in vault" (otherwise they
  expire like other results), info line "Results appear as a source: Scheduled · {name}". `Start schedule`.
  Desktop shows an active schedule as a card with a pause switch, "Edit schedule" and "Run now".

### 5.2 Jobs (`JobsMobile`, `JobResultMobile`, `JobsDesktop`)
- Tabs **Recent** / **Scheduled · n**. Header: GPU state pill; sort/filter button (sort is always visible as
  a label, e.g. "Newest first").
- Recent: rows grouped by day (Today, Earlier this week…), virtualised, "Show older" at the end, multi-select
  via long-press / checkbox with bulk Keep/Delete. Row = thumbnail (style or source image; dimmed while
  waiting), title (prompt excerpt, 1 line), meta (type · style · ×n), status pill, optional progress bar.
- **GPU offline**: one neutral card "3 jobs wait for the GPU and start on their own." No red, no toast.
- Scheduled: one card per schedule (name, cadence, next run, run count, active switch, last results strip,
  "+44" → opens the source in Editor).
- **Result** (mobile grid page / desktop right panel): title, Done pill + time + duration, expiry caption
  ("Unkept results go on Nov 14"), `Run again`, 2×2 variants. Per variant: Keep (to vault), Discard (5 s
  undo), Download, Use in editor, More like this (→ Create prefilled). Parameters list (prompt, style,
  character, output, negative). "Keep remaining n", "Download all".
- **Full-screen viewer** (always dark): close, "2 of 4", swipe between variants, pinch/double-tap zoom
  (1–4×, swipe disabled when zoomed), swipe down to close, bottom bar Keep / Download / Discard / More —
  ending 88 px before the right edge.

### 5.3 Editor (`EditorPickMobile`, `EditorPickDesktop`, `EditorMobile`, `EditorDesktop`)
- **Picker**: source tabs Vault · Scheduled · iCloud · Documents · Generated; sort chip (default "Recently
  edited"); search + date filter behind one button on mobile (inline on desktop); 3-col (mobile) /
  auto-fill 150 px (desktop) grid; tile badge = number of steps applied. Header **vault ring** (colour only;
  tap → vault). Picking from a source **copies it into the vault** (desktop action bar shows size and free
  space after). Upload / camera. Partial loading: show loaded tiles + skeletons + "8 of 46".
- **Workspace**: title only (no version jargon), compare toggle, zoom, Save to documents, Download.
  Canvas with before/after slider.
- **Tools** (mobile bottom sheet with a 4-button tool bar; desktop right panel):
  - **Enhance** — one tap, no options.
  - **Face swap** — multi-select character bubbles + "New"; caption "Matched by gender & age";
    button "Swap with n". No face detection UI.
  - **Blur** — strength slider. When blur is applied: `Remove blur` + `Update blur`.
  - **Edit** — visible, disabled, "soon".
- **History is linear**: Original → Enhanced → Ana + Milo → Blur. A pending step shows dashed with an
  indeterminate bar; the canvas stays usable while it runs.
- **Blur rule**: blur is always the last step. Applying it stores the pre-blur image. `Remove blur`
  restores it (one tap, no confirmation needed on desktop; mobile confirmation optional — see the
  "Remove blur?" dialog in Components). Running Enhance/Face swap on a blurred image applies to the
  pre-blur image and blur is re-applied on top automatically.
- Vault impact shown where saving happens (ring + "+2.4 MB").

### 5.4 Automate (`WorkflowsMobile`, `WorkflowEditMobile`, `WorkflowsDesktop`)
- List: card per workflow — name, active switch, status ("18 new today · 2 min ago", "4 waiting for the
  GPU", "Paused · last ran Tue"), source pills, step chain pills, recent results strip.
- Builder (vertical flow): **Sources** (multi: Scheduled · {name}, iCloud · {album}, Generated, Documents,
  + add) → steps **Enhance**, **Face swap** (characters, multi) → `Add step` → **Blur** pinned last
  ("Always last", strength, on/off switch, caption "Removable later, image by image").
  Steps can be removed; order of Enhance/Face swap may be reordered; Blur cannot move.
- Output summary: "1 result per new image", mini chain Original → Before blur → Result.
- Desktop adds an **Activity** feed (Running / Done n images / failed with Retry).
- Semantics: a workflow runs on images that **arrive after** it is activated (offer "Also run on the 46
  existing images?" on first save — not designed yet). Each image → one job chain → one result in the vault,
  with the pre-blur copy retained.

### 5.5 Characters (`CharactersMobile`, `CharacterEditMobile`, `CharactersDesktop`)
- Grid of round covers, name, face count; warning state "1 face · add more" (amber). Sort chip, search
  button, `+`. Empty state: "Keep the same face across all your images." + Create / Pick from vault.
- Edit (dialog on mobile, side panel on desktop), POC style: name + rename + delete icon; one hint line;
  **Gender** pills Any / Woman / Man; **Age** pills Any / Child / Teen / Young / Adult / Senior
  ("Any" = no filter; used by the partner to pick the face to replace); faces grid with **n / 8** counter,
  main face (star), remove ×, reorder (drag / long-press), add tile; per-photo hint tags in amber
  ("Blurry", "Crop" when several faces, "Small"). Footer: `Add photos` + `Done`.
- "Used in 31 images" with thumbnails; "Create with {name}".

### 5.6 Settings (`SettingsMobile`, `SettingsDesktop`)
Theme (System / Dark / Light), Language, default Style, default Quality, "Keep unkept results for"
(1 / 7 / 30 days), Locke Vault (ring/quota + Open vault ↗), Sign out (running jobs continue).

## 6. Job lifecycle & feedback

```
submit ─► queued ─► (waiting_for_gpu) ─► running ─► done
                                            └────► failed      done ──(keep period)──► expired
```

| Status | Pill | UI feedback |
|---|---|---|
| `queued` | neutral, hollow dot, "3rd" | row enters top (fade + 8 px, 200 ms); live position |
| `waiting_for_gpu` | neutral, plug icon, "Waiting" | single calm card in Jobs; no toast, no badge |
| `running` | blue, % if known else "Running" + indeterminate bar | **no image preview** |
| `done` | success | toast with thumbnail + "Open"; Jobs badge +1; push only if app in background |
| `failed` | danger + plain reason + Retry | toast with reason; "nothing was changed" |
| `expired` | muted dashed | parameters kept; "Run again" |

Worker status: `online` (idle) / `busy` / `offline`, always with the waiting count.
Live updates: subscribe (SSE/WebSocket) or poll every 5 s while any job is active; back off when idle.
Push notifications: opt-in after the first finished job; text is generic ("Locke · 4 results are ready").
Live regions (polite): "Job queued, 3rd in line", "4 results ready", "GPU offline, 3 jobs waiting".

## 7. Suggested data model (adjust to the real API)

```ts
type Theme = 'system' | 'dark' | 'light';
type JobType = 'generate' | 'enhance' | 'face_swap' | 'blur' | 'edit';
type JobStatus = 'queued' | 'waiting_for_gpu' | 'running' | 'done' | 'failed' | 'expired';

interface PromptFragment { id: string; text: string; enabled: boolean; }
interface Prompt {
  id: string; name: string;
  positive: PromptFragment[]; negative: PromptFragment[];
  styleId: string; characterId?: string; referenceIds: string[]; // ≤ 4, ordered
  aspect: 'square' | 'portrait' | 'landscape'; count: 1 | 2 | 3 | 4; mode: 'fast' | 'quality';
  scheduleId?: string; updatedAt: string;
}
interface Schedule {
  id: string; promptId: string; name: string;            // name is also the vault source name
  repeat: 'minute' | 'hour' | 'day' | 'week'; times?: string[]; weekdays?: number[];
  active: boolean; keepResults: boolean; nextRunAt?: string; runCount: number;
}
interface Job {
  id: string; type: JobType; status: JobStatus; createdAt: string;
  progress?: number;             // 0–1 when the worker reports steps
  queuePosition?: number; failureReason?: string; expiresAt?: string;
  params: Record<string, unknown>; resultIds: string[]; scheduleId?: string; workflowId?: string;
}
interface WorkerState { status: 'online' | 'busy' | 'offline'; waiting: number; lastSeenAt?: string; }

interface Character {
  id: string; name: string;
  gender: 'any' | 'woman' | 'man';
  age: 'any' | 'child' | 'teen' | 'young' | 'adult' | 'senior';
  faces: { id: string; mainFace: boolean; hints: ('blurry' | 'small' | 'multiple_faces')[] }[]; // ≤ 8
}
type SourceKind = 'vault' | 'scheduled' | 'icloud' | 'documents' | 'generated';
interface VaultItem {
  id: string; title: string; sizeBytes: number; createdAt: string; editedAt: string;
  history: { id: string; op: 'original' | 'enhance' | 'face_swap' | 'blur'; label: string;
             createdAt: string; jobId?: string; pending?: boolean }[]; // linear
  preBlurStepId?: string;      // set while a blur step is applied → enables "Remove blur"
}
interface Workflow {
  id: string; name: string; active: boolean;
  sources: { kind: SourceKind; id: string; label: string }[];
  steps: ({ op: 'enhance' } | { op: 'face_swap'; characterIds: string[] })[];
  blur?: { strength: number };  // always executed last when present
}
interface Quota { usedBytes: number; totalBytes: number }  // 256 MB
```

## 8. Cross-cutting rules
- **Assistant corner** (88 × 88 + safe-area, bottom-right): no buttons, toasts or FABs there. Mobile sticky
  bars use `padding-right: 88px`; desktop panels keep ≥ 72 px bottom margin near the right edge.
- **Home-screen app**: `display: standalone`, `viewport-fit=cover`; headers add `env(safe-area-inset-top)`,
  dock adds `env(safe-area-inset-bottom) + 8px`. No pull-to-refresh except Jobs. Keep iOS edge-swipe back.
- **Loading** = skeletons (`.skel`), partial data shown as it arrives. **Errors** inline with a next step.
- **Quota**: ring grey < 85 %, amber ≥ 85 %, red at 100 %. Blocking dialog only when an action needs space
  (Keep / copy into vault): "Manage vault" / "Download instead".
- **i18n**: ICU messages (e.g. `react-intl` or `i18next`), `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`,
  `Intl.NumberFormat` for MB ("3,1 Mo"). Pills and buttons may wrap; only prompts and file names truncate
  (full text on hover/long-press).
- **A11y**: real `<button>`/`<a>`; pills `aria-pressed`; tabs `role=tab`; switches `role=switch`; sliders
  native range; dialogs/sheets trap focus and restore it; toasts never steal focus.

## 9. Key states checklist (see `States.dc.html`)
Empty (Create suggestions, no jobs, empty vault, no characters) · loading skeletons (list, variants
arriving, grids) · inline errors (couldn't send — prompt saved; job failed with reason; source unavailable)
· GPU offline ("Run now" becomes "Add to queue") · vault almost full / full · long French strings ·
100+ jobs (grouping, bulk select, virtualised) · 20+ characters (search first).

## 10. Implementation order (each step shippable)
1. App shell: tokens, fonts, theme switch, routes, dock / rail / sidebar, assistant-corner guard, toasts.
2. Component library (§4) in Storybook or a `/kitchen-sink` route, both themes.
3. Jobs data layer (API client, live updates, worker state) + Jobs list + result + viewer.
4. Create: fragment model ↔ raw text, saved prompts, presets, characters, references, Run now.
5. Schedules (sheet, Jobs › Scheduled, scheduled sources).
6. Editor: picker (sources, sort, copy-into-vault, quota), workspace, Enhance / Face swap / Blur + linear
   history + Remove blur.
7. Characters (grid, editor dialog/panel, photo hints).
8. Automate (list, builder, activity).
9. Settings, i18n (EN + FR), push notifications, reduced-motion & a11y pass.

**Acceptance per screen**: matches the board in both themes at 390 px and 1440 px; nothing interactive
inside the assistant corner; keyboard reachable; no spinner while a job runs.

## 11. Placeholder images (`/_blob/<id>` in the reference files)

| id | file |
|---|---|
| 49f5c35875d79cdd1f8639ed04b97484 | coast.svg |
| 5d603aae02d27c9370ce9724e81fce7b | portrait-ana.svg |
| 615333cb7a7451c46b14f19e5d1cc710 | portrait-milo.svg |
| d841ff50912394cbfa20e00483e2fecb | portrait-rose.svg |
| 603ff0cb7d029ea8f9a5e95b09cda895 | portrait-jun.svg |
| 45841a3c0c37777adabfb8651c5d55db | city.svg |
| 749b96d7a90709f1d81a579fc22d00eb | forest.svg |
| ca494b0bfe456651a08cc89949f6a17a | manga.svg |
| 13c380256699ac3f901e2eb726da7630 | dunes.svg |
| d424b7bc2418aaeb0000494dde022456 | stilllife.svg |
| b98f848812490c10d9dfbf0ebffcc2f1 | cafe-duo.svg |

## 12. Open questions for the team
1. Partner/worker API: progress granularity, queue position, failure codes → user-facing reasons.
2. Do scheduled runs with "Keep results in vault" off count against the 256 MB quota while unkept?
3. Workflows on existing images when first activated — offer a back-fill? (not designed).
4. Minimum schedule interval in production ("every minute" is in the design; may need a plan limit).
5. Remove blur: confirm on mobile or rely on a toast with Undo? (design shows both options).
6. Age brackets shown as "Young" for "young adult" to fit pills — confirm wording, especially in FR.
