import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { usePrefs, type LangPref, type ThemePref } from "../app/prefs.tsx";
import { useAuth, useQuota, VAULT_URL } from "../app/session.tsx";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { QuotaRing } from "../components/QuotaRing.tsx";

function Pills<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="opt-row">
      <span className="opt-label">{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.v} type="button" aria-pressed={o.v === value} onClick={() => onChange(o.v)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Account pages live in the platform: the identity provider's account console (Keycloak: password, sessions) and
 * Ilven Account (profile sharing, plan, API key). With Cloudflare Access there is no account console to link.
 */
function useAccountConsole(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    fetch("/ilven-config.json")
      .then((r) => r.json() as Promise<{ authMode: string; issuer: string }>)
      .then((c) => setUrl(c.authMode === "oidc" && /^https?:\/\//.test(c.issuer) ? `${c.issuer.replace(/\/$/, "")}/account` : null))
      .catch(() => setUrl(null));
  }, []);
  return url;
}

function AccountLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <a className="app-link-row" href={href}>
      <span className="app-col">
        <span className="t-label">{title}</span>
        <span className="t-caption c2">{hint}</span>
      </span>
      <Icon name="external" size={16} />
    </a>
  );
}

export function SettingsPage() {
  const { t, bytes } = useI18n();
  const { prefs, set } = usePrefs();
  const auth = useAuth();
  const q = useQuota();
  const accountConsole = useAccountConsole();
  return (
    <Page title={t("settings.title")}>
      <section className="card app-stack">
        <Pills<ThemePref> label={t("settings.theme")} value={prefs.theme} onChange={(theme) => set({ theme })}
          options={[{ v: "system", label: t("settings.theme.system") }, { v: "dark", label: t("settings.theme.dark") }, { v: "light", label: t("settings.theme.light") }]} />
        <Pills<LangPref> label={t("settings.language")} value={prefs.lang} onChange={(lang) => set({ lang })}
          options={[{ v: "system", label: t("settings.language.system") }, { v: "en", label: "English" }, { v: "fr", label: "Français" }]} />
      </section>
      <section className="card app-stack">
        <h2 className="t-title-s">{t("settings.vault")}</h2>
        <div className="app-row">
          {q && q !== "error" && <QuotaRing quota={q} inset="var(--surface-1)" />}
          <span className="lockcue">
            <Icon name="lock" size={16} />
            {q === "error" ? t("vault.unavailable") : q ? t("vault.free", { free: bytes(Math.max(0, q.limit - q.used)) }) : " "}
          </span>
          <a className="btn btn-secondary app-push" href={VAULT_URL}>{t("vault.open")} <Icon name="external" size={16} /></a>
        </div>
      </section>
      <section className="card app-stack">
        <h2 className="t-title-s">{t("settings.account")}</h2>
        {auth.name && <p className="t-body-s c2">{auth.name}</p>}
        <div className="app-links">
          {accountConsole && <AccountLink href={accountConsole} title={t("settings.account.password")} hint={t("settings.account.password.hint")} />}
          <AccountLink href={`/account/?return=${encodeURIComponent(location.href)}`} title={t("settings.account.profile")} hint={t("settings.account.profile.hint")} />
        </div>
        <div><button type="button" className="btn btn-secondary" onClick={() => void auth.logout()}>{t("settings.signout")}</button></div>
        <p className="hint">{t("settings.signout.hint")}</p>
      </section>
    </Page>
  );
}
