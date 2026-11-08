import { createContext, useContext, useMemo, type ReactNode } from "react";
import { en, type Message, type MessageKey } from "./en.ts";
import { fr } from "./fr.ts";

/**
 * Minimal i18n: message catalogs per language, {placeholders}, plurals through Intl.PluralRules, and Intl
 * formatters for numbers, sizes and dates. Components never hard-code user-facing text.
 */
export type Lang = "en" | "fr";
const CATALOGS: Record<Lang, Record<MessageKey, Message>> = { en, fr };

export function resolveLang(pref: Lang | "system"): Lang {
  if (pref !== "system") return pref;
  return navigator.languages.some((l) => l.toLowerCase().startsWith("fr")) ? "fr" : "en";
}

export interface I18n {
  lang: Lang;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
  bytes(n: number): string;
  time(d: Date): string;
}

function make(lang: Lang): I18n {
  const plural = new Intl.PluralRules(lang);
  const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  const mb = new Intl.NumberFormat(lang, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1 });
  const kb = new Intl.NumberFormat(lang, { style: "unit", unit: "kilobyte", unitDisplay: "short", maximumFractionDigits: 0 });
  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" });
  return {
    lang,
    t(key, vars = {}) {
      const m = CATALOGS[lang][key] ?? en[key];
      if (typeof m === "string") return fill(m, vars);
      const n = Number(vars.n ?? 0);
      return fill(plural.select(n) === "one" ? m.one : m.other, vars);
    },
    bytes: (n) => (n >= 1024 * 1024 ? mb.format(n / 1024 / 1024) : kb.format(Math.max(1, Math.round(n / 1024)))),
    time: (d) => time.format(d),
  };
}

const Ctx = createContext<I18n>(make("en"));
export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => make(lang), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
