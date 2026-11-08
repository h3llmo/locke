# Locke — AI photo studio (web app)

Private, encrypted image creation and editing. Generate from prompts, enhance, blur, face-swap with
recurring characters, and automate those steps on new images. Mobile (iPhone home-screen web app) and
desktop are equally important.

**Start with `docs/HANDOFF.md`.** It is the build spec. The visual design lives in the canvas linked
there; `docs/design/reference/*.dc.html` are its source files, for exact spacing and markup only.

## Stack
- React 18 + Vite + TypeScript. Plain CSS with the tokens and component classes in `src/styles/locke.css`
  (do not re-invent colours or spacing; extend that file).
- Fonts: Inter (UI), Space Grotesk (titles ≥ 20 px only), loaded from Google Fonts.
- Icons: inline SVG, 24 grid, 1.75 stroke, `currentColor` (class `ic`). Path data in `docs/HANDOFF.md` §4.

## Non-negotiable rules
1. **Assistant corner:** the platform injects a round assistant button bottom-right on every page.
   Keep `right: 0; bottom: 0; 88 × 88 px` (+ safe-area inset) free of any interactive UI at every breakpoint.
2. **Jobs are asynchronous.** Never block the UI with a spinner while a job runs. Submit → toast → keep working.
3. **No generation preview.** Jobs are sealed on the partner side; show progress only, never partial images.
4. **Face swap is automatic.** The user picks one or more characters; the partner matches faces using
   each character's gender and age. No face boxes or per-face assignment in the UI.
5. **History is linear. Blur is always the last step** and keeps the pre-blur image so "Remove blur" can
   roll back. No branching alternatives.
6. **Colour rule:** mint (`--accent`) = do (primary buttons, toggles, sliders); blue (`--info-*`) = chosen
   or in progress (selected pills, running jobs). Everything else neutral.
7. **Privacy cues are quiet:** small lock captions, never alarm banners. Notifications never contain
   prompts, character names or images.
8. Accessibility: WCAG AA in both themes, visible focus, 44 px touch targets, reduced-motion variants.
9. i18n-ready: no hard-coded strings in components, `Intl` for dates/numbers, layouts survive +40 % text (FR).

## Conventions
- Theme = class on `<html>`: `lk lk-dark` (default) or `lk lk-light`; "System" follows `prefers-color-scheme`.
- Skeletons for loading, never spinners. Errors inline with a recovery action.
- Mobile < 640 px: bottom dock tab bar. 640–1023: nav rail. ≥ 1024: sidebar.
