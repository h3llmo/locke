import { useEffect, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth, useJobsSummary } from "../app/session.tsx";
import {
  ApiError, cancelJob, deleteJob, downloadResult, isActive, keepResult, useJob, useJobs, useOptions, useResultUrl, type Job, type Options,
} from "../app/jobs.tsx";
import { runPrompt, setSchedule, usePrompts, type SavedPrompt } from "../app/data.tsx";
import { describeCadence } from "../app/cadence.ts";
import { EmptyState, Page } from "../components/Page.tsx";
import { useEdits, type Edit } from "../app/edits.ts";
import { EditProgress, EditStatusPill, EditThumb, useEditTitle } from "./Editor.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toasts.tsx";

export function JobsPage() {
  return (
    <Routes>
      <Route index element={<JobList />} />
      <Route path=":id" element={<JobResult />} />
    </Routes>
  );
}

const statusPill: Record<Job["status"], string> = {
  queued: "", running: "pill-info", done: "pill-success", failed: "pill-danger", cancelled: "pill-muted", expired: "pill-muted",
};

const FAILS = ["unsupported", "invalid_input", "decrypt_failed", "no_face_found", "out_of_memory", "model_missing",
  "engine_unavailable", "timeout", "cancelled", "internal", "lease_expired"];
export const failKey = (code: string | null, type?: Job["type"]) =>
  (code === "no_face_found" && type === "enhance" ? "jobs.fail.no_face_found.enhance" : `jobs.fail.${code && FAILS.includes(code) ? code : "internal"}`) as MessageKey;

export function useDate() {
  const { lang } = useI18n();
  const day = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" });
  return (iso: string) => {
    const d = new Date(iso);
    return new Date().toDateString() === d.toDateString() ? time.format(d) : `${day.format(d)} ${time.format(d)}`;
  };
}

export function styleLabel(o: Options | null | "error", id: string | undefined) {
  if (!id) return undefined;
  return (o && o !== "error" ? o.generate?.styles.find((s) => s.id === id)?.label : undefined) ?? id;
}

/** One line: what the job is (type · style · ×n). */
export function useMeta() {
  const { t } = useI18n();
  const options = useOptions();
  return (j: Job) => {
    if (j.type === "generate") {
      return [t("jobs.type.generate"), styleLabel(options, j.summary?.style), j.summary?.count && j.summary.count > 1 ? `×${j.summary.count}` : null]
        .filter(Boolean).join(" · ");
    }
    if (j.type === "face_swap") return [t("jobs.type.face_swap"), j.summary?.names?.join(", ") ?? t("jobs.characters", { n: j.summary?.characters ?? 1 })].join(" · ");
    if (j.type === "enhance" && j.summary?.level) return `${t("jobs.type.enhance")} · ${t(`automate.strength.${j.summary.level}` as MessageKey)}`;
    if (j.type === "upscale" && j.summary?.scale) return `${t("jobs.type.upscale")} ×${j.summary.scale}`;
    if (j.type === "blur" && j.summary?.strength !== undefined) return `${t("jobs.type.blur")} · ${t("automate.blur.strength", { n: j.summary.strength })}`;
    return t(`jobs.type.${j.type}` as MessageKey);
  };
}

export function StatusPill({ job }: { job: Job }) {
  const { t } = useI18n();
  const label = job.status === "queued" && job.queuePosition ? t("jobs.status.queuedAt", { n: job.queuePosition }) : t(`jobs.status.${job.status}` as MessageKey);
  return <span className={`pill ${statusPill[job.status]}`}>{job.status === "running" && <span className="dot" />}{label}</span>;
}

export function JobProgress({ job }: { job: Job }) {
  if (job.status !== "running") return null;
  const p = job.progress;
  return (
    <div className={p == null ? "progress progress-indet" : "progress"} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p == null ? undefined : Math.round(p * 100)}>
      <span style={p == null ? undefined : { width: `${Math.max(4, Math.round(p * 100))}%` }} />
    </div>
  );
}

function Thumb({ job }: { job: Job }) {
  const done = job.status === "done" && (job.resultCount ?? 0) > 0;
  return (
    <div className="tile app-jobthumb">
      {done ? <ResultImg job={job} n={1} alt="" /> : <span className="app-jobthumb-icon"><Icon name={job.type === "generate" ? "create" : "editor"} /></span>}
    </div>
  );
}

function ResultImg({ job, n, alt }: { job: Job; n: number; alt: string }) {
  const url = useResultUrl(job.id, n);
  if (url === null) return <div className="skel app-fill" />;
  if (url === "error") return <span className="app-jobthumb-icon"><Icon name="close" /></span>;
  return <img src={url} alt={alt} />;
}

/** Calm notice when jobs wait for an absent GPU (no red, no toast). */
export function GpuNotice() {
  const { t } = useI18n();
  const s = useJobsSummary();
  if (s.queued === 0 || s.worker === "online" || s.worker === "busy") return null;
  const key = s.worker === "paused" ? "jobs.wait.paused" : s.worker === "unknown" ? "jobs.wait.none" : "jobs.wait.offline";
  return (
    <div className="app-notice" role="status">
      <Icon name="gpuOffline" />
      <span className="t-body-s c2">{t(key, { n: s.queued })}</span>
    </div>
  );
}

/** Title of a job: the prompt for generations, a translated name for edits (workflow name first when automated). */
export function useJobTitle() {
  const { t } = useI18n();
  return (j: Job) => {
    if (j.type === "generate") return j.summary?.title ?? t("jobs.type.generate");
    const base = t(`jobs.type.${j.type}` as MessageKey);
    const who = j.summary?.names?.length ? ` · ${j.summary.names.join(", ")}` : "";
    return j.summary?.workflow ? `${j.summary.workflow} · ${base}` : `${base}${who}`;
  };
}

function JobList() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "scheduled" ? "scheduled" : "recent";
  const { data: prompts, reload } = usePrompts();
  const scheduled = Array.isArray(prompts) ? prompts.filter((p) => p.schedule) : [];
  return (
    <Page title={t("jobs.title")}>
      <GpuNotice />
      <div className="tabs" role="tablist" aria-label={t("jobs.title")}>
        <button type="button" role="tab" aria-selected={tab === "recent"} onClick={() => setParams({}, { replace: true })}>{t("jobs.tab.recent")}</button>
        <button type="button" role="tab" aria-selected={tab === "scheduled"} onClick={() => setParams({ tab: "scheduled" }, { replace: true })}>
          {t("jobs.tab.scheduled")} {scheduled.length > 0 && <span className="t-num c3">{scheduled.length}</span>}
        </button>
      </div>
      {tab === "recent" ? <RecentJobs /> : <ScheduledList prompts={prompts} scheduled={scheduled} reload={reload} />}
    </Page>
  );
}

/** Jobs and edits, newest first: an edit (several steps on one photo) is one row, never one per step. */
function RecentJobs() {
  const { t } = useI18n();
  const { jobs: jobList } = useJobs();
  const { edits } = useEdits();
  const meta = useMeta();
  const title = useJobTitle();
  const editTitle = useEditTitle();
  const when = useDate();
  type Row = { at: string; job?: Job; edit?: Edit };
  const jobs: Row[] | null | "error" = jobList === "error" || edits === "error" ? (Array.isArray(jobList) ? jobList.map((j) => ({ at: j.createdAt, job: j })) : "error")
    : jobList === null || edits === null ? null
    : [...jobList.map((j) => ({ at: j.createdAt, job: j })), ...edits.map((e) => ({ at: e.createdAt, edit: e }))].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      {jobs === null && <div className="app-joblist">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 68, borderRadius: 16 }} />)}</div>}
      {jobs === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {Array.isArray(jobs) && jobs.length === 0 && (
        <EmptyState icon="jobs" text={t("jobs.empty")}>
          <Link className="btn btn-primary" to="/create">{t("jobs.empty.create")}</Link>
        </EmptyState>
      )}
      {Array.isArray(jobs) && jobs.length > 0 && (
        <ul className="app-joblist" role="list">
          {jobs.map(({ job: j, edit: e }) => e ? (
            <li key={e.id}>
              <Link className="app-jobrow" to={`/editor/${e.id}`}>
                <EditThumb edit={e} />
                <span className="app-jobrow-text">
                  <span className="t-body-s clamp1">{editTitle(e)}</span>
                  <span className="t-caption clamp1">{[t("edit.kind"), when(e.createdAt)].join(" · ")}</span>
                  <EditProgress edit={e} />
                </span>
                <EditStatusPill edit={e} />
              </Link>
            </li>
          ) : j && (
            <li key={j.id}>
              <Link className="app-jobrow" to={`/jobs/${j.id}`}>
                <Thumb job={j} />
                <span className="app-jobrow-text">
                  <span className="t-body-s clamp1">{title(j)}</span>
                  <span className="t-caption clamp1">{[meta(j), j.summary?.schedule ? t("jobs.fromSchedule") : null, when(j.createdAt)].filter(Boolean).join(" · ")}</span>
                  <JobProgress job={j} />
                </span>
                <StatusPill job={j} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Jobs › Scheduled: one card per schedule (HANDOFF §5.2). */
function ScheduledList({ prompts, scheduled, reload }: { prompts: SavedPrompt[] | null | "error"; scheduled: SavedPrompt[]; reload(): Promise<void> }) {
  const { t } = useI18n();
  if (prompts === null) return <div className="skel" style={{ height: 160, borderRadius: 18 }} />;
  if (prompts === "error") return <p className="hint hint-error">{t("jobs.error")}</p>;
  if (!scheduled.length) {
    return (
      <EmptyState icon="schedule" text={t("schedule.empty")}>
        <Link className="btn btn-primary" to="/create">{t("jobs.empty.create")}</Link>
      </EmptyState>
    );
  }
  return <div className="app-stack">{scheduled.map((p) => <ScheduleCard key={p.id} prompt={p} reload={reload} />)}</div>;
}

function ScheduleCard({ prompt: p, reload }: { prompt: SavedPrompt; reload(): Promise<void> }) {
  const { t, lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const when = useDate();
  const s = p.schedule!;
  const { jobs } = useJobs(undefined, s.id);
  const done = Array.isArray(jobs) ? jobs.filter((j) => j.status === "done" && (j.resultCount ?? 0) > 0).slice(0, 6) : [];
  const toggle = async () => {
    try { await setSchedule(auth, p.id, { spec: s.spec, active: !s.active, keepResults: s.keepResults }); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : t("jobs.error")); }
  };
  const runNow = async () => {
    try { const r = await runPrompt(auth, p.id); toast(t("create.queued"), { label: t("create.view"), run: () => nav(`/jobs/${r.jobId}`) }); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : t("jobs.error")); }
  };
  return (
    <section className="card app-stack app-schedcard" aria-label={p.name}>
      <div className="app-row">
        <span className="app-grow-0 app-stack-xs">
          <span className="t-title-s clamp1">{p.name}</span>
          <span className="t-caption">{describeCadence(s.spec, t, lang)}{s.keepResults ? ` · ${t("schedule.kept")}` : ""}</span>
        </span>
        <span className="app-grow-0" />
        <button type="button" role="switch" aria-checked={s.active} aria-label={t("schedule.active")} className={`switch ${s.active ? "is-on" : ""}`} onClick={() => void toggle()} />
      </div>
      <p className="t-caption">
        {s.active && s.nextRunAt ? t("schedule.next", { when: when(s.nextRunAt) }) : t("schedule.paused")}
        {" · "}{t("schedule.runs", { n: s.runCount })}
        {s.skippedCount > 0 ? ` · ${t("schedule.skipped", { n: s.skippedCount })}` : ""}
      </p>
      {s.lastError && <p className="hint hint-error">{t(`schedule.error.${["no_worker", "unsupported", "empty_prompt", "character_not_found", "character_without_photos"].includes(s.lastError) ? s.lastError : "other"}` as MessageKey)}</p>}
      {done.length > 0 && (
        <div className="hscroll app-strip">
          {done.map((j) => <Link key={j.id} to={`/jobs/${j.id}`} className="tile app-striptile" aria-label={j.summary?.title ?? ""}><ResultImg job={j} n={1} alt="" /></Link>)}
        </div>
      )}
      <div className="app-row">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void runNow()}><Icon name="play" size={16} />{t("schedule.runNow")}</button>
        <Link className="btn btn-ghost btn-sm" to={`/create/${p.id}`}>{t("schedule.edit")}</Link>
      </div>
    </section>
  );
}

function JobResult() {
  const { id } = useParams();
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const options = useOptions();
  const when = useDate();
  const { lang } = useI18n();
  const { job, reload } = useJob(id);
  const title = useJobTitle();
  const [viewer, setViewer] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [kept, setKept] = useState<Set<number>>(new Set());

  if (job === null) return <Page title={t("jobs.title")}><div className="skel" style={{ height: 240, borderRadius: 18 }} /></Page>;
  if (job === "missing") return <Page title={t("jobs.title")}><EmptyState icon="jobs" text={t("jobs.missing")}><Link className="btn btn-secondary" to="/jobs">{t("jobs.back")}</Link></EmptyState></Page>;

  const n = job.status === "done" ? job.resultCount ?? 0 : 0;
  const keep = async (i: number) => {
    try {
      const how = await keepResult(auth, job, i);
      setKept((k) => new Set(k).add(i));
      toast(t(how === "version" ? "jobs.keptVersion" : "jobs.kept"));
    } catch (e) {
      toast(e instanceof ApiError && e.code === "vault_full" ? t("jobs.keep.full") : t("jobs.keep.error"));
    }
  };
  const download = (i: number) => void downloadResult(auth, job, i).catch(() => toast(t("jobs.download.error")));
  const cancel = async () => { try { await cancelJob(auth, job.id); await reload(); } catch { toast(t("jobs.error")); } };
  const remove = async () => {
    try { await deleteJob(auth, job.id); nav("/jobs"); } catch { toast(t("jobs.error")); }
  };
  const again = () => nav("/create", { state: { from: job } });
  const expiry = job.expiresAt && job.status === "done"
    ? new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(job.expiresAt)) : null;
  const s = job.summary;

  return (
    <div className="app-page">
      <header className="app-header">
        <Link to="/jobs" className="btn btn-ghost app-back"><Icon name="back" />{t("jobs.title")}</Link>
        <span className="app-grow-0" />
        {job.type === "generate" && s?.positive && <button type="button" className="btn btn-secondary btn-sm" onClick={again}>{t("jobs.again")}</button>}
      </header>

      <div className="app-stack-s">
        <h1 className="t-title-m clamp2">{title(job)}</h1>
        <div className="app-row app-pills">
          <StatusPill job={job} />
          <span className="t-caption">{when(job.createdAt)}</span>
          {job.type === "generate" && <span className="pill">{styleLabel(options, s?.style)}</span>}
          {s?.aspect && <span className="pill">{t(`create.aspect.${s.aspect}` as MessageKey)}</span>}
          {s?.mode && <span className="pill">{t(`create.mode.${s.mode}` as MessageKey)}</span>}
          {s?.references ? <span className="pill">{t("create.refs.n", { n: s.references })}</span> : null}
          {s?.character && <span className="pill">{s.character}</span>}
          {s?.names?.map((n) => <span key={n} className="pill">{n}</span>)}
          {s?.schedule && <span className="pill"><Icon name="schedule" size={16} />{s.schedule}</span>}
          {s?.workflow && <span className="pill"><Icon name="automate" size={16} />{s.workflow}</span>}
        </div>
        <JobProgress job={job} />
      </div>

      {job.status === "queued" && <GpuNotice />}
      {job.status === "failed" && (
        <div className="app-notice is-error" role="alert">
          <span className="t-body-s">{t(failKey(job.failureCode, job.type))}</span>
        </div>
      )}
      {isActive(job) && (
        <div className="app-row">
          <button type="button" className="btn btn-secondary" disabled={job.cancelRequested} onClick={() => void cancel()}>
            {t(job.cancelRequested ? "jobs.cancelling" : "jobs.cancel")}
          </button>
        </div>
      )}
      {isActive(job) && job.type === "generate" && (
        <div className="app-results">
          {Array.from({ length: s?.count ?? 1 }, (_, i) => <div key={i} className="tile skel app-result" />)}
        </div>
      )}

      {n > 0 && (
        <>
          <div className="app-results">
            {Array.from({ length: n }, (_, k) => k + 1).map((i) => (
              <div key={i} className="app-result-cell">
                <button type="button" className="tile app-result" onClick={() => setViewer(i)} aria-label={t("jobs.open", { n: i, total: n })}>
                  <ResultImg job={job} n={i} alt={t("jobs.variant", { n: i, total: n })} />
                  {kept.has(i) && <span className="tile-tag"><Icon name="check" size={16} />{t("jobs.keptTag")}</span>}
                </button>
                <div className="app-row app-result-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={kept.has(i)} onClick={() => void keep(i)}>{t("jobs.keep")}</button>
                  <button type="button" className="icon-btn" aria-label={t("jobs.download")} onClick={() => download(i)}><Icon name="download" /></button>
                </div>
              </div>
            ))}
          </div>
          {expiry && <p className="t-caption">{t("jobs.expiry", { date: expiry })}</p>}
          {job.kept && <p className="t-caption">{t("jobs.keptBySchedule")}</p>}
          {s?.vaultItem && <p className="t-caption">{t("jobs.keepAsVersion")}</p>}
        </>
      )}

      {s?.positive && (
        <dl className="app-params card">
          <dt className="t-caption">{t("jobs.params.prompt")}</dt><dd className="t-body-s">{s.positive.join(", ")}</dd>
          {s.negative && s.negative.length > 0 && <><dt className="t-caption">{t("jobs.params.negative")}</dt><dd className="t-body-s">{s.negative.join(", ")}</dd></>}
        </dl>
      )}

      {!isActive(job) && (confirmDelete ? (
        <div className="app-row">
          <span className="t-caption">{t("jobs.delete.confirm")}</span>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove()}>{t("jobs.delete")}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("workers.cancel")}</button>
        </div>
      ) : (
        <div className="app-row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>{t("jobs.delete")}</button></div>
      ))}

      {viewer !== null && n > 0 && (
        <Viewer job={job} n={viewer} total={n} kept={kept.has(viewer)} onMove={setViewer} onClose={() => setViewer(null)}
          onKeep={() => void keep(viewer)} onDownload={() => download(viewer)} />
      )}
    </div>
  );
}

/** Full-screen viewer, always dark. Arrow keys / swipe move between variants; Escape closes. */
function Viewer({ job, n, total, kept, onMove, onClose, onKeep, onDownload }: {
  job: Job; n: number; total: number; kept: boolean; onMove(n: number): void; onClose(): void; onKeep(): void; onDownload(): void;
}) {
  const { t } = useI18n();
  const [startX, setStartX] = useState<number | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && n < total) onMove(n + 1);
      if (e.key === "ArrowLeft" && n > 1) onMove(n - 1);
    };
    window.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; };
  }, [n, total, onMove, onClose]);
  return (
    <div className="app-viewer" role="dialog" aria-modal="true" aria-label={t("jobs.variant", { n, total })}
      onTouchStart={(e) => setStartX(e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const x = e.changedTouches[0]?.clientX;
        if (startX == null || x == null) return;
        if (x - startX < -50 && n < total) onMove(n + 1);
        if (x - startX > 50 && n > 1) onMove(n - 1);
        setStartX(null);
      }}>
      <div className="app-viewer-top">
        <button type="button" className="icon-btn on-image" aria-label={t("jobs.viewer.close")} onClick={onClose} autoFocus><Icon name="close" /></button>
        <span className="t-label t-num">{t("jobs.variant", { n, total })}</span>
        <span style={{ width: 44 }} />
      </div>
      <div className="app-viewer-img"><ResultImg key={n} job={job} n={n} alt={t("jobs.variant", { n, total })} /></div>
      <div className="app-viewer-bar">
        {n > 1 && <button type="button" className="icon-btn on-image" aria-label={t("jobs.viewer.prev")} onClick={() => onMove(n - 1)}><Icon name="back" /></button>}
        <button type="button" className="btn btn-lg app-viewer-keep" disabled={kept} onClick={onKeep}>{t(kept ? "jobs.keptTag" : "jobs.keep")}</button>
        <button type="button" className="icon-btn on-image" aria-label={t("jobs.download")} onClick={onDownload}><Icon name="download" /></button>
        {n < total && <button type="button" className="icon-btn on-image app-flip" aria-label={t("jobs.viewer.next")} onClick={() => onMove(n + 1)}><Icon name="back" /></button>}
      </div>
    </div>
  );
}
