import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "./Icon.tsx";
import { JobPill } from "./Nav.tsx";

/** Page frame: title + actions. On phones the header also carries the job pill and the Settings entry. */
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="app-page">
      <header className="app-header">
        <h1 className="t-title-l app-title">{title}</h1>
        {actions}
        <span className="app-phone-only"><JobPill /></span>
        <NavLink to="/settings" className="icon-btn app-phone-only" aria-label={t("nav.settings")}><Icon name="user" /></NavLink>
      </header>
      {children}
    </div>
  );
}

export function EmptyState({ icon, text, children }: { icon: Parameters<typeof Icon>[0]["name"]; text: string; children?: ReactNode }) {
  return (
    <div className="card app-empty">
      <span className="app-empty-icon"><Icon name={icon} /></span>
      <p className="t-body">{text}</p>
      {children}
    </div>
  );
}
