import { useEffect, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth } from "../app/session.tsx";
import { ApiError, useOptions } from "../app/jobs.tsx";
import {
  deleteWorkflow, enableAutomation, retryRun, saveWorkflow, setWorkflowActive, useAutomation, useCharacters, useWorkflows,
  vaultItemUrl, vaultSources, workflowRuns, type Character, type VaultSource, type Workflow, type WorkflowData, type WorkflowRun, type WorkflowStep,
} from "../app/data.tsx";
import { EmptyState, Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { AuthImg, CharacterBubbles } from "../components/Shared.tsx";
import { useToast } from "../components/Toasts.tsx";
import { useDate } from "./Jobs.tsx";

/**
 * Automate (HANDOFF §5.4): workflows watch vault sources and edit every new image: Enhance / Face swap in the user's
 * order, then Blur, always last. Each image is copied into the vault and every step adds a version there, so the vault's
 * "Undo last step" removes a step image by image. Runs while the user is away with Locke's delegated key (Nevli).
 */
export function AutomatePage() {
  return (
    <Routes>
      <Route index element={<WorkflowList />} />
      <Route path=":id" element={<WorkflowEdit />} />
    </Routes>
  );
}

/** Asks once for Locke's permission to work while the user is away (a delegated key from Nevli). */
function AutomationAccess({ onChange }: { onChange?(): void }) {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const { data, reload } = useAutomation();
  const [busy, setBusy] = useState(false);
  if (data === null || data === "error") return null;
  const allow = async () => {
    setBusy(true);
    try { await enableAutomation(auth); await reload(); onChange?.(); toast(t("automate.access.allowed")); }
    catch (e) { toast(e instanceof ApiError ? e.message : t("jobs.error")); }
    finally { setBusy(false); }
  };
  if (data.enabled && data.working !== false) return null;
  return (
    <section className="card app-stack app-access">
      <div className="app-row"><Icon name="lock" /><h2 className="t-title-s">{t(data.enabled ? "automate.access.revoked" : "automate.access.title")}</h2></div>
      <p className="t-body-s c2">{t("automate.access.text")}</p>
      <p className="hint">{t("automate.access.revoke")}</p>
      <div className="app-row"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void allow()}>{t("automate.access.allow")}</button></div>
    </section>
  );
}

export function useStepLabel() {
  const { t } = useI18n();
  return (s: WorkflowStep | { op: "blur" }, chars: Character[]) => {
    if (s.op === "face_swap") return `${t("jobs.type.face_swap")} · ${s.characters.map((id) => chars.find((c) => c.id === id)?.name ?? "?").join(", ")}`;
    if (s.op === "upscale") return `${t("jobs.type.upscale")} ×${s.scale}`;
    return t(s.op === "blur" ? "jobs.type.blur" : "jobs.type.enhance");
  };
}

function WorkflowList() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const when = useDate();
  const { data, reload } = useWorkflows();
  const { data: characters } = useCharacters();
  const chars = Array.isArray(characters) ? characters : [];
  const label = useStepLabel();
  // Live status while something runs.
  useEffect(() => { const id = setInterval(() => void reload(), 15_000); return () => clearInterval(id); }, [reload]);
  const toggle = async (w: Workflow) => {
    try { await setWorkflowActive(auth, w.id, !w.active); await reload(); }
    catch (e) { toast(e instanceof ApiError && e.code === "automation_required" ? t("automate.access.needed") : e instanceof Error ? e.message : t("jobs.error")); }
  };
  return (
    <Page title={t("automate.title")} actions={Array.isArray(data) && data.length > 0 && <Link className="icon-btn" to="/automate/new" aria-label={t("automate.new")}><Icon name="plus" /></Link>}>
      <AutomationAccess />
      {data === null && <div className="skel" style={{ height: 160, borderRadius: 18 }} />}
      {data === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {Array.isArray(data) && data.length === 0 && (
        <EmptyState icon="automate" text={t("automate.empty")}>
          <Link className="btn btn-primary" to="/automate/new"><Icon name="plus" />{t("automate.new")}</Link>
        </EmptyState>
      )}
      {Array.isArray(data) && data.length > 0 && (
        <div className="app-stack">
          {data.map((w) => (
            <section key={w.id} className="card app-stack app-wfcard" aria-label={w.name}>
              <div className="app-row">
                <Link to={`/automate/${w.id}`} className="app-grow-0 app-stack-xs app-wflink">
                  <span className="t-title-s clamp1">{w.name}</span>
                  <span className="t-caption">{status(w, t, when)}</span>
                </Link>
                <span className="app-grow-0" />
                <button type="button" role="switch" aria-checked={w.active} aria-label={t("automate.active")} className={`switch ${w.active ? "is-on" : ""}`} onClick={() => void toggle(w)} />
              </div>
              {w.lastError && <p className="hint hint-error">{t(errorKey(w.lastError))}</p>}
              <div className="app-pills app-row">{w.sources.map((s) => <span key={`${s.source}|${s.collection}`} className="pill">{s.label}</span>)}</div>
              <div className="flow app-flow">
                {[...w.steps, ...(w.blur ? [{ op: "blur" as const }] : [])].map((s, i) => (
                  <span key={i} className="app-row app-flowstep">
                    {i > 0 && <Icon name="arrow" size={16} />}
                    <span className="pill pill-accent">{label(s, chars)}</span>
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

function status(w: Workflow, t: (k: MessageKey, v?: Record<string, string | number>) => string, when: (iso: string) => string) {
  const s = w.stats;
  const parts: string[] = [];
  if (!w.active) parts.push(w.lastCheckAt ? t("automate.status.pausedSince", { when: when(w.lastCheckAt) }) : t("automate.status.off"));
  if (s.waitingForGpu) parts.push(t("automate.status.waiting", { n: s.waitingForGpu }));
  else if (s.running + s.pending) parts.push(t("automate.status.running", { n: s.running + s.pending }));
  if (s.doneToday) parts.push(t("automate.status.today", { n: s.doneToday }));
  if (s.failedToday) parts.push(t("automate.status.failed", { n: s.failedToday }));
  if (w.active && w.lastCheckAt) parts.push(t("automate.status.checked", { when: when(w.lastCheckAt) }));
  if (w.active && !w.lastCheckAt) parts.push(t("automate.status.starting"));
  return parts.join(" · ");
}
const ERRORS = ["automation_revoked", "source_unavailable", "vault_unavailable"];
const errorKey = (code: string) => `automate.error.${ERRORS.includes(code) ? code : "other"}` as MessageKey;
const FAILS = ["no_face_found", "unsupported_image", "vault_full", "no_worker", "unsupported", "characters_overlap", "character_without_photos", "character_not_found", "cancelled", "item_gone"];

function WorkflowEdit() {
  const { id } = useParams();
  const isNew = id === "new";
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const options = useOptions();
  const caps = options && options !== "error" ? options : null;
  const { data: workflows, reload } = useWorkflows();
  const { data: characters } = useCharacters();
  const chars = Array.isArray(characters) ? characters : [];
  const existing = Array.isArray(workflows) ? workflows.find((w) => w.id === id) ?? null : null;
  const [sources, setSources] = useState<VaultSource[] | null | "error">(null);
  const [d, setD] = useState<WorkflowData | null>(isNew ? { name: "", sources: [], steps: [], blur: null } : null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const label = useStepLabel();

  useEffect(() => { vaultSources(auth).then((s) => setSources(s.filter((x) => x.available)), () => setSources("error")); }, [auth]);
  useEffect(() => { if (existing && !d) setD({ name: existing.name, sources: existing.sources, steps: existing.steps, blur: existing.blur }); }, [existing]); // eslint-disable-line react-hooks/exhaustive-deps
  // A source without an "everything" view (iCloud): an older workflow's "all" meant its first collection.
  useEffect(() => {
    if (!d || !Array.isArray(sources)) return;
    const fixed = d.sources.map((x) => {
      const s = sources.find((y) => y.id === x.source);
      return x.collection === null && s?.allCollections === false && s.collections[0] ? { ...x, collection: s.collections[0].id, label: `${s.name} · ${s.collections[0].name}` } : x;
    });
    if (fixed.some((x, i) => x !== d.sources[i])) setD({ ...d, sources: fixed });
  }, [d, sources]);

  if (!isNew && workflows !== null && !existing) {
    return <Page title={t("automate.title")}><EmptyState icon="automate" text={t("automate.missing")}><Link className="btn btn-secondary" to="/automate">{t("automate.back")}</Link></EmptyState></Page>;
  }
  if (!d) return <Page title={t("automate.title")}><div className="skel" style={{ height: 240, borderRadius: 18 }} /></Page>;

  const hasSource = (source: string, collection: string | null) => d.sources.some((s) => s.source === source && s.collection === collection);
  const toggleSource = (src: VaultSource, collection: { id: string; name: string } | null) => {
    if (hasSource(src.id, collection?.id ?? null)) setD({ ...d, sources: d.sources.filter((s) => !(s.source === src.id && s.collection === (collection?.id ?? null))) });
    else if (d.sources.length < 5) setD({ ...d, sources: [...d.sources, { source: src.id, collection: collection?.id ?? null, label: collection ? `${src.name} · ${collection.name}` : src.name }] });
  };
  const setStep = (i: number, s: WorkflowStep) => setD({ ...d, steps: d.steps.map((x, k) => (k === i ? s : x)) });
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= d.steps.length) return;
    const steps = [...d.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    setD({ ...d, steps });
  };
  const valid = d.name.trim() && d.sources.length > 0 && (d.steps.length > 0 || d.blur) && d.steps.every((s) => s.op !== "face_swap" || s.characters.length > 0);
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const w = await saveWorkflow(auth, isNew ? null : id!, { ...d, name: d.name.trim() });
      await reload();
      toast(t("automate.saved"));
      if (isNew) nav(`/automate/${w.id}`, { replace: true });
    } catch (e) { toast(e instanceof ApiError ? e.message : t("jobs.error")); }
    finally { setBusy(false); }
  };
  const toggleActive = async () => {
    if (!existing) return;
    try { await setWorkflowActive(auth, existing.id, !existing.active); await reload(); }
    catch (e) { toast(e instanceof ApiError && e.code === "automation_required" ? t("automate.access.needed") : e instanceof Error ? e.message : t("jobs.error")); }
  };
  const remove = async () => {
    try { await deleteWorkflow(auth, id!); await reload(); nav("/automate"); } catch { toast(t("jobs.error")); }
  };
  const maxChars = caps?.faceSwap?.maxCharacters ?? 1;

  return (
    <div className="app-page">
      <header className="app-header">
        <Link to="/automate" className="btn btn-ghost app-back"><Icon name="back" />{t("automate.title")}</Link>
        <span className="app-grow-0" />
        {existing && (
          <span className="app-row">
            <span className="t-caption">{t(existing.active ? "automate.on" : "automate.off")}</span>
            <button type="button" role="switch" aria-checked={existing.active} aria-label={t("automate.active")} className={`switch ${existing.active ? "is-on" : ""}`} onClick={() => void toggleActive()} />
          </span>
        )}
      </header>
      <AutomationAccess />

      <label className="field">
        <span className="field-label">{t("automate.name")}</span>
        <input className="input" value={d.name} maxLength={80} placeholder={t("automate.name.placeholder")} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>

      <section className="card app-stack" aria-labelledby="wf-sources">
        <h2 className="t-title-s" id="wf-sources"><span className="app-stepnum">1</span>{t("automate.sources")}</h2>
        <p className="hint">{t("automate.sources.hint")}</p>
        {sources === null && <div className="skel" style={{ height: 44, borderRadius: 12 }} />}
        {sources === "error" && <p className="hint hint-error">{t("picker.error")}</p>}
        {Array.isArray(sources) && sources.map((s) => (
          <div key={s.id} className="app-stack-xs">
            <span className="t-label">{s.name}{s.experimental ? ` · ${t("automate.experimental")}` : ""}</span>
            {s.status !== "ready" ? <span className="hint">{t(s.status === "needs_setup" ? "automate.source.setup" : "automate.source.notAllowed")}</span> : (
              <div className="app-pills app-row">
                {s.filters.collection && s.collections.length > 0
                  ? s.collections.map((c) => (
                    <button key={c.id} type="button" className="chip chip-sm" aria-pressed={hasSource(s.id, c.id)} onClick={() => toggleSource(s, c)}>{c.name}</button>
                  ))
                  : <button type="button" className="chip chip-sm" aria-pressed={hasSource(s.id, null)} onClick={() => toggleSource(s, null)}>{t("automate.source.all")}</button>}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="card app-stack" aria-labelledby="wf-steps">
        <h2 className="t-title-s" id="wf-steps"><span className="app-stepnum">2</span>{t("automate.steps")}</h2>
        {d.steps.map((s, i) => (
          <div key={i} className="app-wfstep">
            <div className="app-row">
              <span className="t-label">{i + 1}. {label(s.op === "face_swap" ? { ...s, characters: [] } : s, chars).split(" · ")[0]}</span>
              <span className="app-grow-0" />
              <button type="button" className="icon-btn app-up" aria-label={t("automate.step.up")} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="back" size={16} /></button>
              <button type="button" className="icon-btn app-down" aria-label={t("automate.step.down")} disabled={i === d.steps.length - 1} onClick={() => move(i, 1)}><Icon name="back" size={16} /></button>
              <button type="button" className="icon-btn" aria-label={t("automate.step.remove")} onClick={() => setD({ ...d, steps: d.steps.filter((_, k) => k !== i) })}><Icon name="trash" size={16} /></button>
            </div>
            {s.op === "face_swap" && (
              <>
                <CharacterBubbles characters={chars} selected={s.characters} onToggle={(cid) => {
                  const on = s.characters.includes(cid);
                  if (!on && s.characters.length >= maxChars) { toast(t("editor.characters.max", { n: maxChars })); return; }
                  setStep(i, { ...s, characters: on ? s.characters.filter((x) => x !== cid) : [...s.characters, cid] });
                }} extra={<Link className="bubble" to="/characters?new=1"><span className="bubble-face app-bubble-empty"><Icon name="plus" /></span><span>{t("editor.character.new")}</span></Link>} />
                <span className="hint">{t("automate.faceswap.hint")}</span>
              </>
            )}
            {s.op === "upscale" && (
              <div className="seg seg-sm">
                {([2, 4] as const).map((x) => <button key={x} type="button" aria-pressed={s.scale === x} disabled={!!caps?.upscale && !caps.upscale.scales.includes(x)} onClick={() => setStep(i, { ...s, scale: x })}>×{x}</button>)}
              </div>
            )}
            {s.op === "enhance" && (
              <div className="seg seg-sm">
                {(["subtle", "balanced", "strong"] as const).map((x) => <button key={x} type="button" aria-pressed={s.strength === x} onClick={() => setStep(i, { ...s, strength: x })}>{t(`automate.strength.${x}` as MessageKey)}</button>)}
              </div>
            )}
          </div>
        ))}
        <div className="app-row">
          {d.steps.length < 4 && <button type="button" className="btn btn-secondary btn-sm" disabled={!caps?.faceSwap} onClick={() => setD({ ...d, steps: [...d.steps, { op: "face_swap", characters: [] }] })}><Icon name="plus" size={16} />{t("jobs.type.face_swap")}</button>}
          {d.steps.length < 4 && <button type="button" className="btn btn-secondary btn-sm" disabled={!caps?.enhance} onClick={() => setD({ ...d, steps: [...d.steps, { op: "enhance", strength: "balanced" }] })}><Icon name="plus" size={16} />{t("jobs.type.enhance")}</button>}
          {d.steps.length < 4 && <button type="button" className="btn btn-secondary btn-sm" disabled={!caps?.upscale} onClick={() => setD({ ...d, steps: [...d.steps, { op: "upscale", scale: caps?.upscale?.scales[0] === 4 ? 4 : 2 }] })}><Icon name="plus" size={16} />{t("jobs.type.upscale")}</button>}
        </div>
        {(!caps?.enhance || !caps?.blur || !caps?.upscale) && <p className="hint">{t("automate.gpuSoon")}</p>}

        <div className="app-wfstep app-wfblur">
          <div className="opt-row">
            <span className="opt-label">{t("jobs.type.blur")} <span className="pill">{t("automate.blur.last")}</span></span>
            <button type="button" role="switch" aria-checked={!!d.blur} aria-label={t("jobs.type.blur")} disabled={!caps?.blur && !d.blur} className={`switch ${d.blur ? "is-on" : ""}`}
              onClick={() => setD({ ...d, blur: d.blur ? null : { strength: 60 } })} />
          </div>
          {d.blur && (
            <label className="field">
              <span className="field-label">{t("automate.blur.strength", { n: d.blur.strength })}</span>
              <input type="range" min={0} max={100} step={5} value={d.blur.strength} onChange={(e) => setD({ ...d, blur: { strength: Number(e.target.value) } })} />
            </label>
          )}
          <span className="hint">{t("automate.blur.hint")}</span>
        </div>
      </section>

      <p className="t-caption">{t("automate.output")}</p>

      <div className="app-row">
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void save()}>{t(isNew ? "automate.create" : "automate.save")}</button>
        {!isNew && (confirmDelete ? (
          <>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>{t("common.delete")}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("workers.cancel")}</button>
          </>
        ) : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>{t("automate.delete")}</button>)}
      </div>
      {isNew && <p className="hint">{t("automate.afterCreate")}</p>}

      {existing && <Activity workflow={existing} />}
    </div>
  );
}

function Activity({ workflow }: { workflow: Workflow }) {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const when = useDate();
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const load = () => workflowRuns(auth, workflow.id).then(setRuns, () => setRuns((r) => r ?? []));
  useEffect(() => { void load(); const id = setInterval(() => void load(), 10_000); return () => clearInterval(id); }, [workflow.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const steps = workflow.steps.length + (workflow.blur ? 1 : 0);
  return (
    <section className="app-stack-s" aria-labelledby="wf-activity">
      <h2 className="t-title-s" id="wf-activity">{t("automate.activity")}</h2>
      {runs === null && <div className="skel" style={{ height: 68, borderRadius: 16 }} />}
      {runs && runs.length === 0 && <p className="hint">{t(workflow.active ? "automate.activity.empty" : "automate.activity.off")}</p>}
      {runs && runs.length > 0 && (
        <ul className="app-joblist" role="list">
          {runs.map((r) => (
            <li key={r.id} className="app-jobrow">
              <span className="tile app-jobthumb">{r.itemId ? <AuthImg url={vaultItemUrl(r.itemId)} alt="" /> : <span className="app-jobthumb-icon"><Icon name="automate" /></span>}</span>
              <span className="app-jobrow-text">
                <span className="t-body-s">
                  {r.status === "done" ? t("automate.run.done") : r.status === "failed" ? t(`automate.fail.${FAILS.includes(r.failure ?? "") ? r.failure : "other"}` as MessageKey)
                    : r.jobStatus === "queued" ? t("automate.run.waiting", { n: Math.min(r.step + 1, steps), total: steps }) : t("automate.run.step", { n: Math.min(r.step + 1, steps), total: steps })}
                </span>
                <span className="t-caption">
                  {when(r.updatedAt)}{r.notes.includes("no_face_found") ? ` · ${t("automate.run.noFace")}` : ""}
                </span>
              </span>
              {r.status === "failed" ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void retryRun(auth, workflow.id, r.id).then(load, () => toast(t("jobs.error")))}>{t("automate.retry")}</button>
              ) : (
                <span className={`pill ${r.status === "done" ? "pill-success" : r.status === "running" && r.jobStatus === "running" ? "pill-info" : ""}`}>{t(`automate.run.status.${r.status}` as MessageKey)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {workflow.stats.done > 0 && <p className="hint">{t("automate.activity.vault")}</p>}
    </section>
  );
}

