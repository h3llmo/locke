import { useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth, useIsAdmin } from "../app/session.tsx";
import { ApiError, useOptions } from "../app/jobs.tsx";
import { useCharacters, type WorkflowStep } from "../app/data.tsx";
import {
  cancelEdit, deleteEdit, downloadEdit, editBlob, keepEdit, skippedSteps, submitEdit, useEdit, useEditImage, useEdits, type Edit,
} from "../app/edits.ts";
import { useAssistantContext } from "../app/assistant.ts";
import { EmptyState, Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { VaultPicker } from "../components/VaultPicker.tsx";
import { StepFlow, StepsEditor, offered, stepsReady, useStepLabel } from "../components/Steps.tsx";
import { useToast } from "../components/Toasts.tsx";
import { GpuNotice, failKey, useDate } from "./Jobs.tsx";

/**
 * Editor (HANDOFF §5.3): one photo (uploaded, or from the vault: then the result can be saved as that vault item's next
 * version) and any steps in any order (face swap, enhance, upscale, background blur). Applying them makes one edit:
 * Locke runs the steps one after the other and offers only the final result.
 */
export function EditorPage() {
  return (
    <Routes>
      <Route index element={<EditorHome />} />
      <Route path=":id" element={<EditDetail />} />
    </Routes>
  );
}

interface Photo { file: File; url: string; vaultItem?: string; version?: number }
const MAX_BYTES = 25 * 1024 * 1024;
// Kept while the app is open, so creating a character (another screen) loses neither the photo nor the steps.
let keptPhoto: Photo | null = null;
let keptSteps: WorkflowStep[] = [];

/** Opens the Editor on an image (e.g. an edit's result, to edit it further). */
export function editNext(file: File, vault?: { item: string; version?: number | null }) {
  if (keptPhoto) URL.revokeObjectURL(keptPhoto.url);
  keptPhoto = { file, url: URL.createObjectURL(file), ...(vault ? { vaultItem: vault.item, ...(vault.version ? { version: vault.version } : {}) } : {}) };
  keptSteps = [];
}

function EditorHome() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const options = useOptions();
  const caps = options && options !== "error" ? options : null;
  const { data: characters } = useCharacters();
  const chars = Array.isArray(characters) ? characters : [];
  const [photo, setPhotoState] = useState<Photo | null>(keptPhoto);
  const [steps, setStepsState] = useState<WorkflowStep[]>(keptSteps);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const label = useStepLabel();

  const setPhoto = (p: Photo | null) => { if (keptPhoto && keptPhoto !== p) URL.revokeObjectURL(keptPhoto.url); keptPhoto = p; setPhotoState(p); };
  const setSteps = (s: WorkflowStep[]) => { keptSteps = s; setStepsState(s); setError(null); };
  useAssistantContext("editor", {
    photo: photo ? (photo.vaultItem ? { vaultPhotoId: photo.vaultItem, version: photo.version ?? null } : { notInVault: true }) : null,
    steps: steps.map((s) => label(s, chars)),
  });
  // Forget characters deleted meanwhile.
  useEffect(() => {
    if (!Array.isArray(characters)) return;
    let changed = false;
    const fixed = steps.map((s) => {
      if (s.op !== "face_swap") return s;
      const ok = s.characters.filter((id) => characters.some((c) => c.id === id));
      if (ok.length === s.characters.length) return s;
      changed = true;
      return { ...s, characters: ok };
    });
    if (changed) setSteps(fixed);
  }, [characters]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromFile = (file: File, vault?: { item: string; version?: number }) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast(t("create.refs.type")); return; }
    if (file.size > MAX_BYTES) { toast(t("create.refs.size")); return; }
    setPhoto({ file, url: URL.createObjectURL(file), ...(vault ? { vaultItem: vault.item, ...(vault.version ? { version: vault.version } : {}) } : {}) });
  };

  const ready = !busy && !!photo && stepsReady(steps, chars) && steps.every((s) => offered(caps, s.op));
  const run = async () => {
    if (!ready || !photo) return;
    setBusy(true);
    setError(null);
    try {
      const e = await submitEdit(auth, photo.file, steps, photo.vaultItem ? { item: photo.vaultItem, version: photo.version } : undefined);
      nav(`/editor/${e.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("create.error.send"));
    } finally {
      setBusy(false);
    }
  };
  const nothing = caps && !(["face_swap", "enhance", "upscale", "blur"] as const).some((op) => offered(caps, op));

  return (
    <Page title={t("editor.title")}>
      <GpuNotice />
      {options === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {nothing && (
        <div className="app-notice" role="status">
          <Icon name="gpuOffline" />
          <span className="t-body-s c2">{t(isAdmin ? "editor.noWorker.admin" : "editor.noWorker")}</span>
        </div>
      )}

      <div className="app-editor">
        <section className="card app-stack" aria-labelledby="ed-photo">
          <h2 className="t-title-s" id="ed-photo"><span className="app-stepnum">1</span>{t("editor.photo")}</h2>
          {photo ? (
            <div className="tile app-photo">
              <img src={photo.url} alt={t("editor.photo")} />
              {photo.vaultItem && <span className="tile-tag"><Icon name="lock" size={16} />{photo.version ? t("editor.fromVault.version", { n: photo.version }) : t("editor.fromVault")}</span>}
              <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("editor.photo.remove")} onClick={() => setPhoto(null)}><Icon name="close" size={16} /></button>
            </div>
          ) : (
            <div className="app-photo-pick">
              <button type="button" className="tile app-photo app-ref-add" onClick={() => photoInput.current?.click()}>
                <Icon name="upload" /><span className="t-body-s c2">{t("editor.photo.pick")}</span>
              </button>
              <button type="button" className="tile app-photo app-ref-add" onClick={() => setPicker(true)}>
                <Icon name="vault" /><span className="t-body-s c2">{t("picker.fromVault")}</span>
              </button>
            </div>
          )}
          {photo?.vaultItem && <p className="hint">{t("editor.fromVault.hint")}</p>}
          <input ref={photoInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ""; }} />
        </section>

        <section className="card app-stack" aria-labelledby="ed-steps">
          <div className="app-row">
            <h2 className="t-title-s app-grow-0" id="ed-steps"><span className="app-stepnum">2</span>{t("editor.steps")}</h2>
            <span className="app-grow-0" />
            <span className="lockcue"><Icon name="lock" size={16} />{t("privacy.private")}</span>
          </div>
          <StepsEditor steps={steps} onChange={setSteps} caps={caps} chars={chars} back="/editor" />
        </section>
      </div>

      <div className="app-runbar">
        {error && <p className="hint hint-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready} onClick={() => void run()}>
          <Icon name="editor" />
          {busy ? t("create.sending") : t("editor.run", { n: steps.length })}
        </button>
      </div>

      <RecentEdits />
      {picker && <VaultPicker max={1} stage onClose={() => setPicker(false)} onPick={(p) => { const x = p[0]; if (x) fromFile(x.file, x.vaultItem ? { item: x.vaultItem, version: x.version } : undefined); }} />}
    </Page>
  );
}

export function EditStatusPill({ edit: e }: { edit: Edit }) {
  const { t } = useI18n();
  if (e.status !== "running") {
    const cls = e.status === "done" ? "pill-success" : e.status === "failed" ? "pill-danger" : "pill-muted";
    return <span className={`pill ${cls}`}>{t(`jobs.status.${e.status}` as MessageKey)}</span>;
  }
  const waiting = e.current?.status === "queued";
  return (
    <span className={`pill ${waiting ? "" : "pill-info"}`}>
      {!waiting && <span className="dot" />}
      {waiting && e.current?.queuePosition ? t("jobs.status.queuedAt", { n: e.current.queuePosition }) : t("edit.stepOf", { n: e.step + 1, total: e.steps.length })}
    </span>
  );
}

export function EditProgress({ edit: e }: { edit: Edit }) {
  if (e.status !== "running") return null;
  // Whole edit: finished steps plus the current one's share.
  const p = (e.step + (e.current?.status === "running" ? e.current.progress ?? 0.1 : 0)) / e.steps.length;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
      <span style={{ width: `${Math.max(4, Math.round(p * 100))}%` }} />
    </div>
  );
}

export function EditThumb({ edit: e }: { edit: Edit }) {
  const url = useEditImage(e.id, e.status === "done" ? "result" : "original", e.status === "done" || e.status === "running");
  return (
    <div className="tile app-jobthumb">
      {typeof url === "string" && url !== "error" ? <img src={url} alt="" /> : <span className="app-jobthumb-icon"><Icon name="editor" /></span>}
    </div>
  );
}

export function useEditTitle() {
  const label = useStepLabel();
  return (e: Edit) => e.steps.map((s) => label(s).split(" · ")[0]).join(" → ");
}

function RecentEdits() {
  const { t } = useI18n();
  const { edits } = useEdits(10);
  const when = useDate();
  const title = useEditTitle();
  if (!Array.isArray(edits) || edits.length === 0) return null;
  return (
    <section className="app-stack-s" aria-labelledby="ed-recent">
      <h2 className="t-title-s" id="ed-recent">{t("editor.recent")}</h2>
      <ul className="app-joblist" role="list">
        {edits.slice(0, 5).map((e) => (
          <li key={e.id}>
            <Link className="app-jobrow" to={`/editor/${e.id}`}>
              <EditThumb edit={e} />
              <span className="app-jobrow-text">
                <span className="t-body-s clamp1">{title(e)}</span>
                <span className="t-caption">{when(e.createdAt)}</span>
                <EditProgress edit={e} />
              </span>
              <EditStatusPill edit={e} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const editFailKey = (code: string | null, e: Edit) => {
  const AUTOMATE = ["unsupported_image", "no_worker", "characters_overlap", "character_without_photos", "character_not_found"];
  if (code && AUTOMATE.includes(code)) return `automate.fail.${code}` as MessageKey;
  return failKey(code, e.steps[e.step]?.op === "enhance" ? "enhance" : "face_swap");
};

function EditDetail() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const when = useDate();
  const { edit, reload } = useEdit(id);
  const { data: characters } = useCharacters();
  const chars = Array.isArray(characters) ? characters : [];
  const title = useEditTitle();
  const label = useStepLabel();
  const [show, setShow] = useState<"result" | "original">("result");
  const [kept, setKept] = useState<{ item: string; version: number | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loaded = !!edit && edit !== "missing";
  const done = loaded && edit.status === "done";
  const which = done ? show : "original";
  const img = useEditImage(id ?? "", which, loaded && (done || edit.status === "running"));

  if (edit === null) return <Page title={t("editor.title")}><div className="skel" style={{ height: 240, borderRadius: 18 }} /></Page>;
  if (edit === "missing") return <Page title={t("editor.title")}><EmptyState icon="editor" text={t("edit.missing")}><Link className="btn btn-secondary" to="/editor">{t("edit.back")}</Link></EmptyState></Page>;
  const e = edit;
  const skipped = skippedSteps(e);

  const keep = async () => {
    try {
      const r = await keepEdit(auth, e, title(e));
      setKept({ item: r.item, version: r.version });
      toast(r.how === "version" && r.version ? t("edit.keptVersion", { n: r.version }) : t("jobs.kept"));
    } catch (x) {
      toast(x instanceof ApiError && x.code === "vault_full" ? t("jobs.keep.full") : t("jobs.keep.error"));
    }
  };
  const further = async () => {
    try {
      const blob = await editBlob(auth, e.id, "result");
      const file = new File([blob], `locke-${e.operation}.${blob.type === "image/jpeg" ? "jpg" : "png"}`, { type: blob.type });
      editNext(file, kept ? { item: kept.item, version: kept.version } : e.vaultItem ? { item: e.vaultItem } : undefined);
      nav("/editor");
    } catch { toast(t("jobs.error")); }
  };
  const cancel = async () => { try { await cancelEdit(auth, e.id); await reload(); } catch { toast(t("jobs.error")); } };
  const remove = async () => { try { await deleteEdit(auth, e.id); nav("/editor"); } catch { toast(t("jobs.error")); } };
  const expiry = e.expiresAt && e.status === "done" ? new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(e.expiresAt)) : null;

  return (
    <div className="app-page">
      <header className="app-header">
        <Link to="/editor" className="btn btn-ghost app-back"><Icon name="back" />{t("editor.title")}</Link>
      </header>

      <div className="app-stack-s">
        <h1 className="t-title-m clamp2">{title(e)}</h1>
        <div className="app-row app-pills">
          <EditStatusPill edit={e} />
          <span className="t-caption">{when(e.createdAt)}</span>
          {e.vaultItem && <span className="pill"><Icon name="lock" size={16} />{e.vaultVersion ? t("editor.fromVault.version", { n: e.vaultVersion }) : t("editor.fromVault")}</span>}
        </div>
        <StepFlow steps={e.steps} chars={chars} current={e.status === "done" ? e.steps.length : e.step} skipped={skipped} />
        <EditProgress edit={e} />
      </div>

      {e.status === "running" && e.current?.status === "queued" && <GpuNotice />}
      {e.status === "failed" && (
        <div className="app-notice is-error" role="alert">
          <span className="t-body-s">{t("edit.failedAt", { step: label(e.steps[e.step] ?? e.steps[0]!, chars).split(" · ")[0]! })} {t(editFailKey(e.failure, e))}</span>
        </div>
      )}
      {skipped.size > 0 && (
        <p className="hint">{t("edit.skippedList", { list: [...skipped].map((i) => label(e.steps[i]!, chars).split(" · ")[0]).join(", ") })}</p>
      )}

      {(done || e.status === "running") && (
        <div className="app-stack-s">
          {done && (
            <div className="seg seg-sm" role="radiogroup" aria-label={t("edit.compare")}>
              {(["original", "result"] as const).map((x) => (
                <button key={x} type="button" role="radio" aria-checked={show === x} aria-pressed={show === x} onClick={() => setShow(x)}>{t(x === "result" ? "edit.after" : "edit.before")}</button>
              ))}
            </div>
          )}
          <div className="tile app-editimg">
            {img === null && <div className="skel" style={{ height: 240 }} />}
            {typeof img === "string" && img !== "error" && <img src={img} alt={t(which === "result" ? "edit.after" : "edit.before")} />}
            {kept && which === "result" && <span className="tile-tag"><Icon name="check" size={16} />{t("jobs.keptTag")}</span>}
          </div>
          {done && e.result && <p className="t-caption t-num">{e.result.width} × {e.result.height} · {(e.result.bytes / 1024 / 1024).toFixed(1)} MB</p>}
        </div>
      )}

      {done && (
        <div className="app-row app-pills">
          <button type="button" className="btn btn-primary" disabled={!!kept} onClick={() => void keep()}>
            <Icon name="vault" />{t(kept ? "jobs.keptTag" : e.vaultItem ? "edit.keepVersion" : "jobs.keep")}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void further()}><Icon name="editor" />{t("edit.continue")}</button>
          <button type="button" className="icon-btn" aria-label={t("jobs.download")} onClick={() => void downloadEdit(auth, e).catch(() => toast(t("jobs.download.error")))}><Icon name="download" /></button>
        </div>
      )}
      {done && <p className="hint">{t(e.vaultItem ? "edit.keepVersion.hint" : "edit.keep.hint")}</p>}
      {expiry && <p className="t-caption">{t("jobs.expiry", { date: expiry })}</p>}

      {e.status === "running" ? (
        <div className="app-row"><button type="button" className="btn btn-secondary" onClick={() => void cancel()}>{t("edit.cancel")}</button></div>
      ) : confirmDelete ? (
        <div className="app-row">
          <span className="t-caption">{t("jobs.delete.confirm")}</span>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>{t("edit.delete")}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("workers.cancel")}</button>
        </div>
      ) : (
        <div className="app-row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>{t("edit.delete")}</button></div>
      )}
    </div>
  );
}
