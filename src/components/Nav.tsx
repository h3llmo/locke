import { NavLink } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { useJobsSummary, useQuota, VAULT_URL } from "../app/session.tsx";
import { Icon, LockeMark, type IconName } from "./Icon.tsx";
import { QuotaRing } from "./QuotaRing.tsx";
import type { MessageKey } from "../i18n/en.ts";

export const SECTIONS: { path: string; icon: IconName; label: MessageKey }[] = [
  { path: "/create", icon: "create", label: "nav.create" },
  { path: "/jobs", icon: "jobs", label: "nav.jobs" },
  { path: "/editor", icon: "editor", label: "nav.editor" },
  { path: "/automate", icon: "automate", label: "nav.automate" },
  { path: "/characters", icon: "characters", label: "nav.characters" },
];

/** Phones (< 640 px): floating dock, active tab labelled, others icon-only. Leaves the assistant corner free. */
export function MobileDock() {
  const { t } = useI18n();
  const jobs = useJobsSummary();
  return (
    <nav className="dock app-dock" aria-label={t("nav.main")}>
      {SECTIONS.map((s) => (
        <NavLink key={s.path} to={s.path} aria-label={t(s.label)}>
          <Icon name={s.icon} />
          <span className="dock-label">{t(s.label)}</span>
          {s.path === "/jobs" && jobs.unseen > 0 && <span className="badge-count app-dock-badge">{jobs.unseen}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** Global job indicator: header pill on phones, card in the sidebar. Links to Jobs. */
export function JobPill() {
  const { t } = useI18n();
  const j = useJobsSummary();
  return (
    <NavLink className="jobpill" to="/jobs" aria-label={t("jobs.indicator.aria", { running: j.running, queued: j.queued })}>
      <span className={j.running ? "dot" : "dot dot-hollow"} style={{ color: j.running ? "var(--info)" : "var(--text-3)" }} />
      <span className="t-num">{j.running} · {j.queued}</span>
    </NavLink>
  );
}

function JobCard() {
  const { t } = useI18n();
  const j = useJobsSummary();
  const active = j.running + j.queued > 0;
  const gpu = { online: "gpu.online", busy: "gpu.busy", offline: "gpu.offline", unknown: "gpu.unknown" } as const;
  return (
    <NavLink to="/jobs" className="sb-extra app-jobcard">
      <span className="t-label app-row">
        <span className={active ? "dot" : "dot dot-hollow"} style={{ color: j.running ? "var(--info)" : "var(--text-3)" }} />
        <span className="t-num">
          {active ? `${t("jobs.indicator.running", { n: j.running })} · ${t("jobs.indicator.queued", { n: j.queued })}` : t("jobs.indicator.idle")}
        </span>
      </span>
      <span className="t-caption app-row"><Icon name={j.worker === "offline" ? "gpuOffline" : "gpu"} size={16} />{t(gpu[j.worker])}</span>
    </NavLink>
  );
}

function VaultLink() {
  const { t, bytes } = useI18n();
  const q = useQuota();
  return (
    <a className="sb-extra app-vault" href={VAULT_URL}>
      {q && q !== "error" ? <QuotaRing quota={q} /> : <span className="ring skel" aria-hidden="true" />}
      <span className="app-col">
        <span className="t-label">{t("vault.label")}</span>
        <span className="lockcue">
          {q === "error" ? t("vault.unavailable") : q ? t("vault.free", { free: bytes(Math.max(0, q.limit - q.used)) }) : " "}
        </span>
      </span>
    </a>
  );
}

/**
 * Tablets and desktops. ≥ 1280 px: 248 px sidebar with job card and vault ring.
 * 640–1279 px: 72 px rail (icon + short label). Same markup, CSS decides.
 */
export function Sidebar() {
  const { t } = useI18n();
  const jobs = useJobsSummary();
  return (
    <aside className="sidebar app-sidebar" aria-label={t("nav.main")}>
      <NavLink to="/create" className="app-brand">
        <span className="app-brand-mark"><LockeMark /></span>
        <span className="app-brand-name">{t("app.name")}</span>
      </NavLink>
      <nav className="app-nav">
        {SECTIONS.map((s) => (
          <NavLink key={s.path} to={s.path} className="nav-item">
            <Icon name={s.icon} />
            <span className="app-nav-label">{t(s.label)}</span>
            {s.path === "/jobs" && jobs.unseen > 0 && <span className="badge-count">{jobs.unseen}</span>}
          </NavLink>
        ))}
      </nav>
      <JobCard />
      <div className="app-sidebar-foot">
        <VaultLink />
        <NavLink to="/settings" className="nav-item">
          <span className="app-avatar"><Icon name="user" size={16} /></span>
          <span className="app-nav-label">{t("nav.settings")}</span>
        </NavLink>
      </div>
    </aside>
  );
}
