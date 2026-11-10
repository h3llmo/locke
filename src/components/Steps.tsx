import { Link } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import type { Options } from "../app/jobs.tsx";
import type { Character, Level, WorkflowStep } from "../app/data.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { CharacterBubbles } from "./Shared.tsx";
import { useToast } from "./Toasts.tsx";

/**
 * Steps on one photo, in any order: shared by the Editor (one edit) and Automate (every new image of a workflow).
 * Each step is one GPU job; the result of one is the input of the next.
 */
export const MAX_STEPS = 6;
export type Op = WorkflowStep["op"];
export const OPS: { op: Op; icon: IconName }[] = [
  { op: "face_swap", icon: "characters" }, { op: "enhance", icon: "create" }, { op: "upscale", icon: "expand" }, { op: "blur", icon: "blur" },
];
const LEVELS: Level[] = ["subtle", "balanced", "strong"];

export const offered = (caps: Options | null, op: Op) =>
  !!caps && !!(op === "face_swap" ? caps.faceSwap : op === "enhance" ? caps.enhance : op === "upscale" ? caps.upscale : caps.blur);

export function newStep(op: Op, caps: Options | null): WorkflowStep {
  if (op === "face_swap") return { op, characters: [] };
  if (op === "enhance") return { op, strength: caps?.enhance?.strengths.includes("balanced") === false ? (caps.enhance.strengths[0] as Level) : "balanced" };
  if (op === "upscale") return { op, scale: caps?.upscale?.scales[0] === 4 ? 4 : 2 };
  return { op, strength: 60 };
}

/** Short label of a step: "Upscale ×2", "Blur · 60", "Enhance · Balanced", "Face swap · Ana". */
export function useStepLabel() {
  const { t } = useI18n();
  return (s: WorkflowStep, chars: Character[] = []) => {
    if (s.op === "face_swap") {
      const names = s.characters.map((id) => chars.find((c) => c.id === id)?.name ?? "?");
      return names.length ? `${t("jobs.type.face_swap")} · ${names.join(", ")}` : t("jobs.type.face_swap");
    }
    if (s.op === "upscale") return `${t("jobs.type.upscale")} ×${s.scale}`;
    if (s.op === "enhance") return `${t("jobs.type.enhance")} · ${t(`automate.strength.${s.strength}` as MessageKey)}`;
    return `${t("jobs.type.blur")} · ${s.strength}`;
  };
}

/** A row of steps with arrows ("Upscale ×2 → Blur · 60"); `done` marks finished steps, `skipped` those that found no face. */
export function StepFlow({ steps, chars, current, skipped }: { steps: WorkflowStep[]; chars?: Character[]; current?: number; skipped?: Set<number> }) {
  const label = useStepLabel();
  const { t } = useI18n();
  return (
    <div className="flow app-flow">
      {steps.map((s, i) => (
        <span key={i} className="app-row app-flowstep">
          {i > 0 && <Icon name="arrow" size={16} />}
          <span className={`pill ${current === undefined || i === current ? "pill-accent" : i < current ? "pill-success" : ""}`} title={skipped?.has(i) ? t("edit.skipped") : undefined}>
            {current !== undefined && i < current && <Icon name={skipped?.has(i) ? "close" : "check"} size={16} />}
            {label(s, chars)}
          </span>
        </span>
      ))}
    </div>
  );
}

export function StepsEditor({ steps, onChange, caps, chars, back }: {
  steps: WorkflowStep[]; onChange(s: WorkflowStep[]): void; caps: Options | null; chars: Character[];
  /** Where "New character" comes back to. */
  back: string;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const label = useStepLabel();
  const maxChars = caps?.faceSwap?.maxCharacters ?? 1;
  const levels = caps?.enhance?.strengths ?? LEVELS;
  const scales = caps?.upscale?.scales ?? [2, 4];
  const set = (i: number, s: WorkflowStep) => onChange(steps.map((x, k) => (k === i ? s : x)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const missing = OPS.filter((o) => caps && !offered(caps, o.op));

  return (
    <div className="app-stack">
      {steps.length === 0 && <p className="hint">{t("steps.empty")}</p>}
      {steps.map((s, i) => (
        <div key={i} className="app-wfstep">
          <div className="app-row">
            <span className="t-label">{i + 1}. {label(s.op === "face_swap" ? { ...s, characters: [] } : s).split(" · ")[0]}</span>
            <span className="app-grow-0" />
            <button type="button" className="icon-btn app-up" aria-label={t("automate.step.up")} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="back" size={16} /></button>
            <button type="button" className="icon-btn app-down" aria-label={t("automate.step.down")} disabled={i === steps.length - 1} onClick={() => move(i, 1)}><Icon name="back" size={16} /></button>
            <button type="button" className="icon-btn" aria-label={t("automate.step.remove")} onClick={() => onChange(steps.filter((_, k) => k !== i))}><Icon name="trash" size={16} /></button>
          </div>
          {!offered(caps, s.op) && caps && <span className="hint hint-error">{t("steps.unavailable")}</span>}
          {s.op === "face_swap" && (
            <>
              <CharacterBubbles characters={chars} selected={s.characters} onToggle={(cid) => {
                const on = s.characters.includes(cid);
                if (!on && maxChars === 1) { set(i, { ...s, characters: [cid] }); return; }
                if (!on && s.characters.length >= maxChars) { toast(t("editor.characters.max", { n: maxChars })); return; }
                set(i, { ...s, characters: on ? s.characters.filter((x) => x !== cid) : [...s.characters, cid] });
              }} extra={<Link className="bubble" to={`/characters?new=1&back=${encodeURIComponent(back)}`}><span className="bubble-face app-bubble-empty"><Icon name="plus" /></span><span>{t("editor.character.new")}</span></Link>} />
              <span className="hint">{t(chars.length ? (maxChars > 1 ? "editor.characters.pick.n" : "editor.characters.pick") : "editor.characters.none", { n: maxChars })}</span>
              {s.characters.some((id) => !chars.find((c) => c.id === id)?.faces.length) && <span className="hint hint-error">{t("editor.characters.noPhotos")}</span>}
            </>
          )}
          {s.op === "enhance" && (
            <>
              <div className="seg seg-sm" role="radiogroup" aria-label={t("editor.enhance.level")}>
                {LEVELS.map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={s.strength === x} aria-pressed={s.strength === x} disabled={!levels.includes(x)} onClick={() => set(i, { ...s, strength: x })}>
                    {t(`automate.strength.${x}` as MessageKey)}
                  </button>
                ))}
              </div>
              <span className="hint">{t("editor.enhance.hint")}</span>
            </>
          )}
          {s.op === "upscale" && (
            <>
              <div className="seg seg-sm" role="radiogroup" aria-label={t("editor.upscale.scale")}>
                {([2, 4] as const).map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={s.scale === x} aria-pressed={s.scale === x} disabled={!scales.includes(x)} onClick={() => set(i, { ...s, scale: x })}>×{x}</button>
                ))}
              </div>
              <span className="hint">{t("editor.upscale.hint")}</span>
            </>
          )}
          {s.op === "blur" && (
            <>
              <label className="field">
                <span className="field-label">{t("automate.blur.strength", { n: s.strength })}</span>
                <input type="range" min={0} max={100} step={5} value={s.strength} onChange={(e) => set(i, { ...s, strength: Number(e.target.value) })} />
              </label>
              <span className="hint">{t("editor.blur.hint")}</span>
            </>
          )}
        </div>
      ))}
      {steps.length < MAX_STEPS && (
        <div className="app-row app-pills">
          {OPS.map((o) => (
            <button key={o.op} type="button" className="btn btn-secondary btn-sm" disabled={!!caps && !offered(caps, o.op)} onClick={() => onChange([...steps, newStep(o.op, caps)])}>
              <Icon name="plus" size={16} />{t(`jobs.type.${o.op}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
      {missing.length > 0 && <p className="hint">{t("steps.missing", { list: missing.map((o) => t(`jobs.type.${o.op}` as MessageKey)).join(", ") })}</p>}
    </div>
  );
}

/** A face swap step without characters, or with one that has no photos, can't run. */
export const stepsReady = (steps: WorkflowStep[], chars: Character[]) =>
  steps.length > 0 && steps.every((s) => s.op !== "face_swap" || (s.characters.length > 0 && s.characters.every((id) => !!chars.find((c) => c.id === id)?.faces.length)));
