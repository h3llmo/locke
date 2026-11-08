import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth, useIsAdmin } from "../app/session.tsx";
import { ApiError, submitJob, useOptions, type Job } from "../app/jobs.tsx";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toasts.tsx";
import { GpuNotice } from "./Jobs.tsx";

/**
 * Create: the prompt editor (HANDOFF §5.1). A prompt is a list of comma-separated fragments, each one can be switched
 * off without deleting it; the same fragments can be edited as raw text. Positive and negative sides.
 * Saved prompts and schedules come later; the draft is kept in this browser only.
 */
interface Frag { id: number; text: string; on: boolean }
type Side = "positive" | "negative";
type Aspect = "square" | "portrait" | "landscape";
type Mode = "fast" | "quality";
interface Draft { positive: Frag[]; negative: Frag[]; style: string; aspect: Aspect; count: number; mode: Mode }

const DRAFT_KEY = "locke.create.draft";
let seq = 1;
const frag = (text: string, on = true): Frag => ({ id: seq++, text, on });
const split = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);
const readDraft = (): Partial<Draft> | null => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    if (!d) return null;
    return { ...d, positive: (d.positive ?? []).map((f) => frag(f.text, f.on)), negative: (d.negative ?? []).map((f) => frag(f.text, f.on)) };
  } catch { return null; }
};
const MAX_REF_BYTES = 25 * 1024 * 1024;

export function CreatePage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const location = useLocation();
  const isAdmin = useIsAdmin();
  const options = useOptions();
  const gen = options && options !== "error" ? options.generate : null;

  const [d, setD] = useState<Draft>(() => {
    const from = (location.state as { from?: Job } | null)?.from?.summary;
    if (from?.positive) {
      return {
        positive: from.positive.map((x) => frag(x)), negative: (from.negative ?? []).map((x) => frag(x)), style: from.style ?? "",
        aspect: (from.aspect as Aspect) ?? "portrait", count: from.count ?? 1, mode: (from.mode as Mode) ?? "fast",
      };
    }
    const saved = readDraft();
    return { positive: [], negative: [], style: "", aspect: "portrait", count: 1, mode: "fast", ...saved };
  });
  const [side, setSide] = useState<Side>("positive");
  const [mode, setMode] = useState<"list" | "raw">("list");
  const [panel, setPanel] = useState<"style" | "aspect" | "count" | "mode" | "refs" | null>(null);
  const [refs, setRefs] = useState<{ file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusId = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode: the draft just isn't kept */ }
  }, [d]);
  useEffect(() => () => refs.forEach((r) => URL.revokeObjectURL(r.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the chosen style/count valid for what the GPU offers.
  useEffect(() => {
    if (!gen) return;
    setD((x) => ({
      ...x,
      style: gen.styles.some((s) => s.id === x.style) ? x.style : (gen.styles.find((s) => s.id === "photo-neutre") ?? gen.styles[0])?.id ?? "",
      count: gen.counts.includes(x.count) ? x.count : gen.counts[0] ?? 1,
    }));
  }, [gen]);

  const frags = d[side];
  const setFrags = (f: Frag[]) => setD((x) => ({ ...x, [side]: f }));
  const enabled = (s: Side) => d[s].filter((f) => f.on && f.text.trim());
  const raw = useMemo(() => enabled(side).map((f) => f.text.trim()).join(", "), [d, side]); // eslint-disable-line react-hooks/exhaustive-deps
  const styleName = gen?.styles.find((s) => s.id === d.style)?.label ?? d.style;

  const addFrag = () => {
    const f = frag("");
    focusId.current = f.id;
    setFrags([...frags, f]);
  };
  const editRaw = (text: string) => {
    const kept = frags.filter((f) => !f.on && f.text.trim());
    setFrags([...split(text).map((x) => frag(x)), ...kept]);
  };

  const addRefs = (files: FileList | null) => {
    if (!files) return;
    const max = gen?.maxReferences ?? 4;
    const next = [...refs];
    for (const file of Array.from(files)) {
      if (next.length >= max) { toast(t("create.refs.max", { n: max })); break; }
      if (!/^image\/(png|jpeg)$/.test(file.type)) { toast(t("create.refs.type")); continue; }
      if (file.size > MAX_REF_BYTES) { toast(t("create.refs.size")); continue; }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setRefs(next);
  };
  const removeRef = (i: number) => {
    URL.revokeObjectURL(refs[i]!.url);
    setRefs(refs.filter((_, k) => k !== i));
  };

  const canRun = !!gen && !!d.style && enabled("positive").length > 0 && !busy;
  const run = async () => {
    if (!canRun) {
      if (gen && enabled("positive").length === 0) setError(t("create.error.empty"));
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("params", JSON.stringify({
      type: "generate",
      positive: enabled("positive").map((f) => f.text.trim()),
      negative: enabled("negative").map((f) => f.text.trim()),
      style: d.style, aspect: d.aspect, count: d.count, mode: d.mode,
      references: refs.map((_, i) => `ref${i + 1}`),
    }));
    refs.forEach((r, i) => form.set(`ref${i + 1}`, r.file, r.file.name));
    try {
      const job = await submitJob(auth, form);
      const where = job.queuePosition && job.queuePosition > 1 ? t("create.queued.pos", { n: job.queuePosition }) : t("create.queued");
      toast(where, { label: t("create.view"), run: () => nav(`/jobs/${job.id}`) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("create.error.send"));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void run(); }
  };

  const chip = (id: NonNullable<typeof panel>, label: string, extra?: ReactNode) => (
    <button type="button" className="chip" aria-expanded={panel === id} aria-pressed={panel === id} onClick={() => setPanel(panel === id ? null : id)}>
      {extra}{label}
    </button>
  );

  return (
    <Page title={t("create.title")}>
      <GpuNotice />
      {options === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {options && options !== "error" && !gen && (
        <div className="app-notice" role="status">
          <Icon name="gpuOffline" />
          <span className="t-body-s c2">{t(isAdmin ? "create.noWorker.admin" : "create.noWorker")}</span>
        </div>
      )}

      <div className="app-create" onKeyDown={onKey}>
        <section className="card app-prompt" aria-label={t("create.prompt")}>
          <div className="app-row app-prompt-bar">
            <div className="toolbar" role="group" aria-label={t("create.mode")}>
              <button type="button" className={`icon-btn ${mode === "list" ? "is-on" : ""}`} aria-pressed={mode === "list"} aria-label={t("create.list")} onClick={() => setMode("list")}>
                <Icon name="list" />
              </button>
              <button type="button" className={`icon-btn ${mode === "raw" ? "is-on" : ""}`} aria-pressed={mode === "raw"} aria-label={t("create.raw")} onClick={() => setMode("raw")}>
                <Icon name="text" />
              </button>
            </div>
            <span className="t-label t-num c3">{enabled(side).length} / {frags.filter((f) => f.text.trim()).length}</span>
            <span className="app-grow-0" />
            <button type="button" className="btn btn-ghost btn-sm" disabled={frags.length === 0} onClick={() => setFrags([])}>{t("create.clear")}</button>
          </div>
          <div className="app-row">
            <div className="tabs" role="tablist" aria-label={t("create.side")}>
              <button type="button" role="tab" aria-selected={side === "positive"} onClick={() => setSide("positive")}>
                {t("create.positive")} <span className="t-num c3">{enabled("positive").length}</span>
              </button>
              <button type="button" role="tab" aria-selected={side === "negative"} onClick={() => setSide("negative")}>
                {t("create.negative")} <span className="t-num c3">{enabled("negative").length}</span>
              </button>
            </div>
            <span className="app-grow-0" />
            <span className="lockcue"><Icon name="lock" size={16} />{t("privacy.private")}</span>
          </div>

          {mode === "list" ? (
            <>
              {frags.length === 0 && <p className="hint">{t(side === "positive" ? "create.hint.positive" : "create.hint.negative")}</p>}
              <ol className="toklist app-toklist">
                {frags.map((f, i) => (
                  <li key={f.id} className={`tok ${f.on ? "" : "is-off"} ${side === "negative" ? "is-neg" : ""}`}>
                    <span className="tok-num">{i + 1}</span>
                    <input
                      className="tok-text app-tok-input"
                      value={f.text}
                      maxLength={500}
                      aria-label={t("create.fragment", { n: i + 1 })}
                      placeholder={t("create.fragment.placeholder")}
                      ref={(el) => { if (el && focusId.current === f.id) { el.focus(); focusId.current = null; } }}
                      onChange={(e) => {
                        const v = e.target.value.replace(/^\s+/, "");
                        if (v.includes(",")) {
                          // Typing a comma starts the next fragment.
                          const parts = v.split(",");
                          const rest = parts.slice(1).map((x) => frag(x.trimStart()));
                          if (rest.length) focusId.current = rest[rest.length - 1]!.id;
                          setFrags([...frags.slice(0, i), { ...f, text: parts[0]! }, ...rest, ...frags.slice(i + 1)]);
                        } else setFrags(frags.map((x) => (x.id === f.id ? { ...x, text: v } : x)));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addFrag(); }
                        if (e.key === "Backspace" && f.text === "") { e.preventDefault(); setFrags(frags.filter((x) => x.id !== f.id)); }
                      }}
                      onBlur={() => { if (!f.text.trim()) setFrags(frags.filter((x) => x.id !== f.id)); }}
                    />
                    <button
                      type="button" role="switch" aria-checked={f.on} className={`switch ${f.on ? "is-on" : ""}`}
                      aria-label={t("create.include", { text: f.text || String(i + 1) })}
                      onClick={() => setFrags(frags.map((x) => (x.id === f.id ? { ...x, on: !x.on } : x)))}
                    />
                  </li>
                ))}
              </ol>
              <button type="button" className="btn btn-ghost btn-sm app-addfrag" onClick={addFrag}><Icon name="plus" size={16} />{t("create.addFragment")}</button>
            </>
          ) : (
            <>
              <textarea
                className="input app-raw" value={raw} rows={6} maxLength={6000} aria-label={t(side === "positive" ? "create.positive" : "create.negative")}
                placeholder={t(side === "positive" ? "create.hint.positive" : "create.hint.negative")}
                onChange={(e) => editRaw(e.target.value)}
              />
              <span className="t-caption">{t("create.raw.hint")}</span>
            </>
          )}
        </section>

        <div className="app-settings">
          <div className="hscroll app-chips" role="group" aria-label={t("create.settings")}>
            {chip("style", styleName || t("create.style"))}
            {chip("aspect", t(`create.aspect.${d.aspect}` as MessageKey))}
            {chip("count", `×${d.count}`)}
            {chip("mode", t(`create.mode.${d.mode}` as MessageKey))}
            {chip("refs", refs.length ? t("create.refs.n", { n: refs.length }) : t("create.refs"),
              refs.length ? <span className="app-chip-thumbs">{refs.slice(0, 2).map((r) => <img key={r.url} src={r.url} alt="" />)}</span> : <Icon name="plus" size={16} />)}
          </div>

          {panel && (
            <div className="card app-panel">
              {panel === "style" && (
                <>
                  <span className="field-label">{t("create.style")}</span>
                  <div className="seg">
                    {(gen?.styles ?? []).map((s) => (
                      <button key={s.id} type="button" aria-pressed={d.style === s.id} onClick={() => { setD({ ...d, style: s.id }); setPanel(null); }}>{s.label}</button>
                    ))}
                  </div>
                </>
              )}
              {panel === "aspect" && (
                <>
                  <span className="field-label">{t("create.aspect")}</span>
                  <div className="seg">
                    {(["square", "portrait", "landscape"] as const).map((a) => (
                      <button key={a} type="button" aria-pressed={d.aspect === a} onClick={() => { setD({ ...d, aspect: a }); setPanel(null); }}>
                        <span className={`app-aspect app-aspect-${a}`} aria-hidden="true" />{t(`create.aspect.${a}` as MessageKey)}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {panel === "count" && (
                <>
                  <span className="field-label">{t("create.count")}</span>
                  <div className="seg">
                    {(gen?.counts ?? [1]).map((n) => (
                      <button key={n} type="button" aria-pressed={d.count === n} onClick={() => { setD({ ...d, count: n }); setPanel(null); }}>{t("workers.gen.results", { n })}</button>
                    ))}
                  </div>
                </>
              )}
              {panel === "mode" && (
                <>
                  <span className="field-label">{t("create.speed")}</span>
                  <div className="seg">
                    {(["fast", "quality"] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={d.mode === m} onClick={() => { setD({ ...d, mode: m }); setPanel(null); }}>{t(`create.mode.${m}` as MessageKey)}</button>
                    ))}
                  </div>
                  <span className="hint">{t(d.mode === "fast" ? "create.mode.fast.hint" : "create.mode.quality.hint")}</span>
                </>
              )}
              {panel === "refs" && (
                <>
                  <span className="field-label">{t("create.refs")}</span>
                  <span className="hint">{t("create.refs.hint", { n: gen?.maxReferences ?? 4 })}</span>
                  <div className="app-refs">
                    {refs.map((r, i) => (
                      <div key={r.url} className="tile app-ref">
                        <img src={r.url} alt={t("create.refs.item", { n: i + 1 })} />
                        <span className="tile-tag t-num">{i + 1}</span>
                        <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("create.refs.remove", { n: i + 1 })} onClick={() => removeRef(i)}><Icon name="close" size={16} /></button>
                      </div>
                    ))}
                    {refs.length < (gen?.maxReferences ?? 4) && (
                      <button type="button" className="tile app-ref app-ref-add" onClick={() => fileInput.current?.click()}>
                        <Icon name="upload" /><span className="t-caption">{t("create.refs.add")}</span>
                      </button>
                    )}
                  </div>
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { addRefs(e.target.files); e.target.value = ""; }} />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="app-runbar">
        {error && <p className="hint hint-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canRun} onClick={() => void run()}>
          <Icon name="play" />{t(busy ? "create.sending" : "create.run")}
        </button>
      </div>
    </Page>
  );
}
