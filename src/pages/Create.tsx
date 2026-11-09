import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth, useIsAdmin } from "../app/session.tsx";
import { ApiError, submitJob, useOptions, type Job } from "../app/jobs.tsx";
import {
  authBlob, deletePrompt, deleteSchedule, refUrl, savePrompt, setSchedule, useCharacters, usePrompts,
  type SavedPrompt, type ScheduleSpec,
} from "../app/data.tsx";
import { browserTz, describeCadence } from "../app/cadence.ts";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { AuthImg, CharacterBubbles, Sheet } from "../components/Shared.tsx";
import { VaultPicker } from "../components/VaultPicker.tsx";
import { useToast } from "../components/Toasts.tsx";
import { GpuNotice, useDate } from "./Jobs.tsx";

/**
 * Create: the prompt editor (HANDOFF §5.1). A prompt is a list of comma-separated fragments, each one can be switched
 * off without deleting it; the same fragments can be edited as raw text. Positive and negative sides.
 * Prompts can be saved (with their references and character), reopened from /create/:promptId, and run on a schedule.
 * The working draft is also kept in this browser.
 */
interface Frag { id: number; text: string; on: boolean }
type Side = "positive" | "negative";
type Aspect = "square" | "portrait" | "landscape";
type Mode = "fast" | "quality";
interface Draft { positive: Frag[]; negative: Frag[]; style: string; aspect: Aspect; count: number; mode: Mode; character: string | null; promptId: string | null; name: string }
interface Ref { file: File; url: string }

const DRAFT_KEY = "locke.create.draft";
let seq = 1;
const frag = (text: string, on = true): Frag => ({ id: seq++, text, on });
const split = (raw: string) => raw.split(",").map((x) => x.trim()).filter(Boolean);
const EMPTY: Draft = { positive: [], negative: [], style: "", aspect: "portrait", count: 1, mode: "fast", character: null, promptId: null, name: "" };
const readDraft = (): Partial<Draft> | null => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    if (!d) return null;
    return { ...d, positive: (d.positive ?? []).map((f) => frag(f.text, f.on)), negative: (d.negative ?? []).map((f) => frag(f.text, f.on)) };
  } catch { return null; }
};
const fromSaved = (p: SavedPrompt): Draft => ({
  positive: p.positive.map((f) => frag(f.text, f.on)), negative: p.negative.map((f) => frag(f.text, f.on)), style: p.style, aspect: p.aspect,
  count: p.count, mode: p.mode, character: p.character, promptId: p.id, name: p.name,
});
const bodyOf = (d: Draft, name: string) => ({
  name, style: d.style, aspect: d.aspect, count: d.count, mode: d.mode, character: d.character,
  positive: d.positive.filter((f) => f.text.trim()).map((f) => ({ text: f.text.trim(), on: f.on })),
  negative: d.negative.filter((f) => f.text.trim()).map((f) => ({ text: f.text.trim(), on: f.on })),
});
const MAX_REF_BYTES = 25 * 1024 * 1024;

export function CreatePage() {
  return (
    <Routes>
      {/* One route for /create and /create/:promptId, so opening a prompt doesn't remount the editor. */}
      <Route path="*" element={<CreateEditor />} />
    </Routes>
  );
}

function CreateEditor() {
  const { t, lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const location = useLocation();
  const promptId = useParams()["*"] || undefined;
  const isAdmin = useIsAdmin();
  const options = useOptions();
  const gen = options && options !== "error" ? options.generate : null;
  const { data: prompts, reload: reloadPrompts } = usePrompts();
  const { data: characters } = useCharacters();
  const saved = Array.isArray(prompts) ? prompts : [];
  const chars = Array.isArray(characters) ? characters : [];

  const [d, setD] = useState<Draft>(() => {
    const from = (location.state as { from?: Job } | null)?.from?.summary;
    if (from?.positive) {
      return {
        ...EMPTY, positive: from.positive.map((x) => frag(x)), negative: (from.negative ?? []).map((x) => frag(x)), style: from.style ?? "",
        aspect: (from.aspect as Aspect) ?? "portrait", count: from.count ?? 1, mode: (from.mode as Mode) ?? "fast",
      };
    }
    return { ...EMPTY, ...readDraft() };
  });
  const [side, setSide] = useState<Side>("positive");
  const [mode, setMode] = useState<"list" | "raw">("list");
  const [panel, setPanel] = useState<"style" | "aspect" | "count" | "mode" | "refs" | "character" | null>(null);
  const [sheet, setSheet] = useState<"saved" | "save" | "schedule" | "vault" | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusId = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode: the draft just isn't kept */ }
  }, [d]);
  useEffect(() => () => refs.forEach((r) => URL.revokeObjectURL(r.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // /create/:promptId opens a saved prompt (with its reference images).
  const current = saved.find((p) => p.id === d.promptId) ?? null;
  const open = async (p: SavedPrompt) => {
    setD(fromSaved(p));
    refs.forEach((r) => URL.revokeObjectURL(r.url));
    setRefs([]);
    try {
      const files = await Promise.all(p.references.map(async (r, i) => {
        const b = await authBlob(auth, refUrl(p.id, r.id));
        return new File([b], `ref${i + 1}.${b.type === "image/png" ? "png" : "jpg"}`, { type: b.type });
      }));
      setRefs(files.map((file) => ({ file, url: URL.createObjectURL(file) })));
    } catch { toast(t("create.saved.refsError")); }
  };
  useEffect(() => {
    if (!promptId || !Array.isArray(prompts)) return;
    const p = prompts.find((x) => x.id === promptId);
    if (p) void open(p);
    else toast(t("create.saved.missing"));
    nav("/create", { replace: true });
  }, [promptId, prompts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the chosen style/count valid for what the GPU offers.
  useEffect(() => {
    if (!gen) return;
    setD((x) => ({
      ...x,
      style: gen.styles.some((s) => s.id === x.style) ? x.style : (gen.styles.find((s) => s.id === "photo-neutre") ?? gen.styles[0])?.id ?? "",
      count: gen.counts.includes(x.count) ? x.count : gen.counts[0] ?? 1,
    }));
  }, [gen]);
  // A deleted character is dropped from the draft.
  useEffect(() => { if (Array.isArray(characters) && d.character && !characters.some((c) => c.id === d.character)) setD((x) => ({ ...x, character: null })); }, [characters]); // eslint-disable-line react-hooks/exhaustive-deps

  const frags = d[side];
  const setFrags = (f: Frag[]) => setD((x) => ({ ...x, [side]: f }));
  const enabled = (s: Side) => d[s].filter((f) => f.on && f.text.trim());
  const raw = useMemo(() => enabled(side).map((f) => f.text.trim()).join(", "), [d, side]); // eslint-disable-line react-hooks/exhaustive-deps
  const styleName = gen?.styles.find((s) => s.id === d.style)?.label ?? d.style;
  const character = chars.find((c) => c.id === d.character) ?? null;
  const dirty = !!current && JSON.stringify(bodyOf(fromSaved(current), current.name)) !== JSON.stringify(bodyOf(d, current.name));

  const addFrag = () => {
    const f = frag("");
    focusId.current = f.id;
    setFrags([...frags, f]);
  };
  const editRaw = (text: string) => {
    const kept = frags.filter((f) => !f.on && f.text.trim());
    setFrags([...split(text).map((x) => frag(x)), ...kept]);
  };

  const max = gen?.maxReferences ?? 4;
  const addRefs = (files: File[]) => {
    const next = [...refs];
    for (const file of files) {
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
      ...(d.character && gen?.character ? { character: d.character } : {}),
      ...(current ? { prompt: current.name } : {}),
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

  /** Saves the draft (new prompt, or overwrites the open one). Returns the saved prompt. */
  const save = async (name: string, asNew: boolean): Promise<SavedPrompt | null> => {
    if (!d.style) { toast(t("create.save.noStyle")); return null; }
    try {
      const p = await savePrompt(auth, asNew ? null : d.promptId, bodyOf(d, name), refs.map((r) => r.file));
      setD((x) => ({ ...x, promptId: p.id, name: p.name }));
      await reloadPrompts();
      toast(t("create.saved"));
      return p;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("create.error.send"));
      return null;
    }
  };
  const quickSave = () => (current ? void save(current.name, false) : setSheet("save"));
  const newPrompt = () => {
    refs.forEach((r) => URL.revokeObjectURL(r.url));
    setRefs([]);
    setD({ ...EMPTY, style: d.style, aspect: d.aspect, count: d.count, mode: d.mode });
  };

  const chip = (id: NonNullable<typeof panel>, label: string, extra?: ReactNode) => (
    <button type="button" className="chip" aria-expanded={panel === id} aria-pressed={panel === id} onClick={() => setPanel(panel === id ? null : id)}>
      {extra}{label}
    </button>
  );

  return (
    <Page title={t("create.title")} actions={
      <button type="button" className="icon-btn" aria-label={t("create.saved.title")} onClick={() => setSheet("saved")}><Icon name="bookmark" /></button>
    }>
      <GpuNotice />
      {options === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {options && options !== "error" && !gen && (
        <div className="app-notice" role="status">
          <Icon name="gpuOffline" />
          <span className="t-body-s c2">{t(isAdmin ? "create.noWorker.admin" : "create.noWorker")}</span>
        </div>
      )}

      {(current || d.promptId) && (
        <div className="app-row app-openprompt">
          <Icon name="bookmark" size={16} />
          <span className="t-body-s clamp1">{current?.name ?? d.name}</span>
          {dirty && <span className="pill">{t("create.saved.dirty")}</span>}
          {current?.schedule && <span className="pill"><Icon name="schedule" size={16} />{current.schedule.active ? describeCadence(current.schedule.spec, t, lang) : t("schedule.paused")}</span>}
          <span className="app-grow-0" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={newPrompt}>{t("create.saved.new")}</button>
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={quickSave}>{t(current ? "create.save" : "create.saveAs")}</button>
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
            {gen?.character && chips(character, chip, t)}
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
              {panel === "character" && (
                <>
                  <span className="field-label">{t("create.character")}</span>
                  <CharacterBubbles characters={chars} selected={d.character ? [d.character] : []}
                    onToggle={(id) => setD({ ...d, character: d.character === id ? null : id })} />
                  <span className="hint">{t(chars.length ? "create.character.hint" : "editor.characters.none")}</span>
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
                  <span className="hint">{t("create.refs.hint", { n: max })}</span>
                  <div className="app-refs">
                    {refs.map((r, i) => (
                      <div key={r.url} className="tile app-ref">
                        <img src={r.url} alt={t("create.refs.item", { n: i + 1 })} />
                        <span className="tile-tag t-num">{i + 1}</span>
                        <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("create.refs.remove", { n: i + 1 })} onClick={() => removeRef(i)}><Icon name="close" size={16} /></button>
                      </div>
                    ))}
                    {refs.length < max && (
                      <>
                        <button type="button" className="tile app-ref app-ref-add" onClick={() => fileInput.current?.click()}>
                          <Icon name="upload" /><span className="t-caption">{t("create.refs.add")}</span>
                        </button>
                        <button type="button" className="tile app-ref app-ref-add" onClick={() => setSheet("vault")}>
                          <Icon name="vault" /><span className="t-caption">{t("picker.vault")}</span>
                        </button>
                      </>
                    )}
                  </div>
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { addRefs(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="app-runbar">
        {error && <p className="hint hint-error" role="alert">{error}</p>}
        <div className="app-row app-runbar-row">
          <button type="button" className="btn btn-secondary btn-lg" disabled={!d.style || enabled("positive").length === 0} onClick={() => setSheet("schedule")}>
            <Icon name="schedule" />{t(current?.schedule ? "schedule.edit" : "schedule.button")}
          </button>
          <button type="button" className="btn btn-primary btn-lg app-grow" disabled={!canRun} onClick={() => void run()}>
            <Icon name="play" />{t(busy ? "create.sending" : "create.run")}
          </button>
        </div>
      </div>

      {sheet === "saved" && (
        <SavedPrompts prompts={prompts} current={d.promptId} onClose={() => setSheet(null)}
          onOpen={(p) => { void open(p); setSheet(null); }}
          onDelete={async (p) => {
            try { await deletePrompt(auth, p.id); await reloadPrompts(); if (d.promptId === p.id) setD((x) => ({ ...x, promptId: null, name: "" })); }
            catch { toast(t("jobs.error")); }
          }} />
      )}
      {sheet === "save" && <SaveSheet initial={d.name || d.positive.find((f) => f.on && f.text.trim())?.text.trim().slice(0, 60) || ""} canOverwrite={!!current}
        onClose={() => setSheet(null)} onSave={async (name, asNew) => { if (await save(name, asNew)) setSheet(null); }} />}
      {sheet === "schedule" && (
        <ScheduleSheet prompt={current} defaultName={d.name || d.positive.find((f) => f.on && f.text.trim())?.text.trim().slice(0, 60) || ""}
          onClose={() => setSheet(null)}
          ensureSaved={async (name) => {
            // A schedule runs a saved prompt: save the current draft first (overwriting the open prompt).
            if (current && !dirty && name === current.name) return current;
            return save(name, !current);
          }}
          onDone={async () => { await reloadPrompts(); setSheet(null); }} />
      )}
      {sheet === "vault" && <VaultPicker max={max - refs.length} onClose={() => setSheet(null)} onPick={(p) => addRefs(p.map((x) => x.file))} />}
    </Page>
  );
}

function chips(character: { name: string; faces: { id: string }[]; id: string } | null, chip: (id: "character", label: string, extra?: ReactNode) => ReactNode, t: (k: MessageKey) => string) {
  return chip("character", character ? character.name : t("create.character"), character ? null : <Icon name="characters" size={16} />);
}

function SavedPrompts({ prompts, current, onOpen, onDelete, onClose }: {
  prompts: SavedPrompt[] | null | "error"; current: string | null; onOpen(p: SavedPrompt): void; onDelete(p: SavedPrompt): Promise<void>; onClose(): void;
}) {
  const { t, lang } = useI18n();
  const when = useDate();
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Sheet title={t("create.saved.title")} onClose={onClose}>
      {prompts === null && <div className="skel" style={{ height: 120, borderRadius: 14 }} />}
      {prompts === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {Array.isArray(prompts) && prompts.length === 0 && <p className="hint">{t("create.saved.empty")}</p>}
      {Array.isArray(prompts) && prompts.length > 0 && (
        <ul className="app-savedlist" role="list">
          {prompts.map((p) => (
            <li key={p.id} className={`app-saved ${p.id === current ? "is-on" : ""}`}>
              <button type="button" className="app-saved-open" onClick={() => onOpen(p)}>
                {p.references[0] ? <AuthImg url={refUrl(p.id, p.references[0].id)} alt="" className="app-saved-thumb" /> : <span className="app-saved-thumb app-jobthumb-icon"><Icon name="create" /></span>}
                <span className="app-jobrow-text">
                  <span className="t-body-s clamp1">{p.name}</span>
                  <span className="t-caption clamp1">{p.positive.filter((f) => f.on).map((f) => f.text).join(", ")}</span>
                  <span className="t-caption">
                    {p.schedule ? `${p.schedule.active ? describeCadence(p.schedule.spec, t, lang) : t("schedule.paused")} · ` : ""}{when(p.updatedAt)}
                  </span>
                </span>
              </button>
              {confirm === p.id ? (
                <span className="app-row">
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => { void onDelete(p); setConfirm(null); }}>{t("common.delete")}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>{t("workers.cancel")}</button>
                </span>
              ) : (
                <button type="button" className="icon-btn" aria-label={t("create.saved.delete", { name: p.name })} onClick={() => setConfirm(p.id)}><Icon name="trash" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function SaveSheet({ initial, canOverwrite, onSave, onClose }: { initial: string; canOverwrite: boolean; onSave(name: string, asNew: boolean): Promise<void>; onClose(): void }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const go = async (asNew: boolean) => { if (!name.trim()) return; setBusy(true); await onSave(name.trim(), asNew); setBusy(false); };
  return (
    <Sheet title={t("create.saveAs")} onClose={onClose} footer={
      <div className="app-row">
        <span className="app-grow-0" />
        {canOverwrite && <button type="button" className="btn btn-secondary" disabled={busy || !name.trim()} onClick={() => void go(false)}>{t("create.save")}</button>}
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void go(true)}>{t(canOverwrite ? "create.saveNew" : "create.save")}</button>
      </div>
    }>
      <label className="field">
        <span className="field-label">{t("create.saved.name")}</span>
        <input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(!canOverwrite); }} />
      </label>
      <p className="hint">{t("create.saved.hint")}</p>
    </Sheet>
  );
}

const REPEATS = ["minutes", "hourly", "daily", "weekly"] as const;
const EVERY = [1, 5, 10, 15, 30] as const;

function ScheduleSheet({ prompt, defaultName, ensureSaved, onDone, onClose }: {
  prompt: SavedPrompt | null; defaultName: string; ensureSaved(name: string): Promise<SavedPrompt | null>; onDone(): Promise<void>; onClose(): void;
}) {
  const { t, lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const s = prompt?.schedule ?? null;
  const tz = browserTz();
  const [name, setName] = useState(prompt?.name ?? defaultName);
  const [spec, setSpec] = useState<ScheduleSpec>(s ? s.spec : { repeat: "daily", times: ["07:00"], tz });
  const [keep, setKeep] = useState(s?.keepResults ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const times = spec.repeat === "daily" || spec.repeat === "weekly" ? spec.times : [];
  const repeat = (r: (typeof REPEATS)[number]) => {
    const keepTimes = times.length ? times : ["07:00"];
    setSpec(r === "minutes" ? { repeat: r, every: 15, tz } : r === "hourly" ? { repeat: r, minute: 0, tz } : r === "daily" ? { repeat: r, times: keepTimes, tz } : { repeat: r, weekdays: [1], times: keepTimes, tz });
  };
  const setTimes = (x: string[]) => setSpec(spec.repeat === "daily" ? { ...spec, times: x } : spec.repeat === "weekly" ? { ...spec, times: x } : spec);
  const weekday = new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" });

  const start = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await ensureSaved(name.trim());
      if (!p) return;
      await setSchedule(auth, p.id, { spec: { ...spec, tz }, active: true, keepResults: keep });
      toast(t("schedule.started"));
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("jobs.error"));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!prompt) return;
    try { await deleteSchedule(auth, prompt.id); toast(t("schedule.removed")); await onDone(); } catch { toast(t("jobs.error")); }
  };

  return (
    <Sheet title={t(s ? "schedule.edit" : "schedule.title")} onClose={onClose} footer={
      <div className="app-row">
        {s && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove()}>{t("schedule.remove")}</button>}
        <span className="app-grow-0" />
        <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || (times.length === 0 && (spec.repeat === "daily" || spec.repeat === "weekly"))} onClick={() => void start()}>
          {t(s ? "schedule.update" : "schedule.start")}
        </button>
      </div>
    }>
      <label className="field">
        <span className="field-label">{t("create.saved.name")}</span>
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">{t("schedule.repeat")}</span>
        <div className="seg seg-sm">
          {REPEATS.map((r) => <button key={r} type="button" aria-pressed={spec.repeat === r} onClick={() => repeat(r)}>{t(`schedule.repeat.${r}` as MessageKey)}</button>)}
        </div>
      </div>
      {spec.repeat === "minutes" && (
        <div className="field">
          <span className="field-label">{t("schedule.every")}</span>
          <div className="seg seg-sm">
            {EVERY.map((n) => <button key={n} type="button" aria-pressed={spec.every === n} onClick={() => setSpec({ ...spec, every: n })}>{t("schedule.minutes", { n })}</button>)}
          </div>
        </div>
      )}
      {spec.repeat === "hourly" && (
        <label className="field">
          <span className="field-label">{t("schedule.atMinute")}</span>
          <select className="input app-select" value={spec.minute} onChange={(e) => setSpec({ ...spec, minute: Number(e.target.value) })}>
            {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
          </select>
        </label>
      )}
      {spec.repeat === "weekly" && (
        <div className="field">
          <span className="field-label">{t("schedule.days")}</span>
          <div className="seg seg-sm">
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
              <button key={wd} type="button" aria-pressed={spec.weekdays.includes(wd)} onClick={() => {
                const next = spec.weekdays.includes(wd) ? spec.weekdays.filter((x) => x !== wd) : [...spec.weekdays, wd];
                if (next.length) setSpec({ ...spec, weekdays: next });
              }}>{weekday.format(new Date(Date.UTC(2026, 10, 8 + wd)))}</button>
            ))}
          </div>
        </div>
      )}
      {(spec.repeat === "daily" || spec.repeat === "weekly") && (
        <div className="field">
          <span className="field-label">{t("schedule.times")}</span>
          <div className="app-row app-times">
            {times.map((x, i) => (
              <span key={i} className="app-time">
                <input type="time" className="input" value={x} aria-label={t("schedule.time", { n: i + 1 })} onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v)) setTimes(times.map((y, k) => (k === i ? v : y))); }} />
                {times.length > 1 && <button type="button" className="icon-btn" aria-label={t("schedule.time.remove")} onClick={() => setTimes(times.filter((_, k) => k !== i))}><Icon name="close" size={16} /></button>}
              </span>
            ))}
            {times.length < 6 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTimes([...times, "19:00"])}><Icon name="plus" size={16} />{t("schedule.time.add")}</button>}
          </div>
        </div>
      )}
      <div className="opt-row">
        <span className="opt-label">{t("schedule.keep")}</span>
        <button type="button" role="switch" aria-checked={keep} aria-label={t("schedule.keep")} className={`switch ${keep ? "is-on" : ""}`} onClick={() => setKeep(!keep)} />
      </div>
      <p className="hint">{t(keep ? "schedule.keep.on" : "schedule.keep.off")}</p>
      <p className="t-caption">{describeCadence({ ...spec, tz }, t, lang)} · {tz}</p>
      <p className="hint">{t("schedule.source", { name: name.trim() || "…" })}</p>
      <p className="hint">{t("schedule.skipHint")}</p>
      {error && <p className="hint hint-error" role="alert">{error}</p>}
    </Sheet>
  );
}
