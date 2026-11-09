import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { usePrefs, type LangPref, type ThemePref } from "../app/prefs.tsx";
import { useAuth, useIsAdmin, useQuota, VAULT_URL } from "../app/session.tsx";
import { GpuWorkers } from "./Workers.tsx";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { QuotaRing } from "../components/QuotaRing.tsx";
import { useToast } from "../components/Toasts.tsx";
import { disableAutomation, removeDiscord, saveDiscord, testDiscord, useAutomation, useNotifications } from "../app/data.tsx";
import { ApiError } from "../app/jobs.tsx";

/**
 * Discord notifications: the user's own channel webhook. Messages are generic ("your image is ready" + a link):
 * no prompt, image or name is sent to Discord.
 */
function DiscordNotifications() {
  const { t, lang } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const { data, set } = useNotifications();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data || data === "error") return null;
  const d = data.discord;
  const run = async (f: () => Promise<typeof data>, ok?: string) => {
    setBusy(true);
    setError(null);
    try { set(await f()); setUrl(""); if (ok) toast(ok); }
    catch (e) { setError(e instanceof ApiError ? e.message : t("jobs.error")); }
    finally { setBusy(false); }
  };
  const failures = d.configured ? d.notifyFailures : true;
  return (
    <section className="card app-stack">
      <h2 className="t-title-s">{t("notify.title")}</h2>
      <p className="t-body-s c2">{t("notify.hint")}</p>
      {d.configured && (
        <p className={`t-caption ${d.lastError ? "app-warn" : ""}`}>
          {d.lastError ? t(d.lastError === "webhook_gone" ? "notify.error.gone" : "notify.error.other") : t("notify.on")}
        </p>
      )}
      <label className="field">
        <span className="field-label">{t(d.configured ? "notify.url.replace" : "notify.url")}</span>
        <input className="input" type="password" autoComplete="off" spellCheck={false} value={url} placeholder="https://discord.com/api/webhooks/…" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="hint">{t("notify.url.how")}</p>
      <div className="opt-row">
        <span className="opt-label">{t("notify.failures")}</span>
        <button type="button" role="switch" aria-checked={failures} aria-label={t("notify.failures")} className={`switch ${failures ? "is-on" : ""}`}
          disabled={!d.configured || busy} onClick={() => void run(() => saveDiscord(auth, { notifyFailures: !failures, lang }))} />
      </div>
      {error && <p className="hint hint-error" role="alert">{error}</p>}
      <div className="app-row">
        <button type="button" className="btn btn-primary" disabled={busy || !url.trim()} onClick={() => void run(() => saveDiscord(auth, { webhookUrl: url.trim(), notifyFailures: failures, lang }), t("notify.saved"))}>{t("notify.save")}</button>
        {d.configured && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => testDiscord(auth), t("notify.tested"))}>{t("notify.test")}</button>}
        {d.configured && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(() => removeDiscord(auth))}>{t("notify.remove")}</button>}
      </div>
    </section>
  );
}

/** "Work while I'm away": Locke's delegated key for workflows. Turning it off revokes the key and pauses workflows. */
function AwayAccess() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const { data, reload } = useAutomation();
  const [confirm, setConfirm] = useState(false);
  if (!data || data === "error" || !data.enabled) return null;
  return (
    <section className="card app-stack">
      <h2 className="t-title-s">{t("settings.away")}</h2>
      <p className="t-body-s c2">{t(data.working === false ? "settings.away.revoked" : "settings.away.on")}</p>
      {confirm ? (
        <div className="app-row">
          <span className="t-caption">{t("settings.away.confirm")}</span>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void disableAutomation(auth).then(reload, () => toast(t("jobs.error")))}>{t("settings.away.off")}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>{t("workers.cancel")}</button>
        </div>
      ) : <div><button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>{t("settings.away.off")}</button></div>}
    </section>
  );
}

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
  const isAdmin = useIsAdmin();
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
      <DiscordNotifications />
      <AwayAccess />
      {isAdmin && <GpuWorkers />}
    </Page>
  );
}
