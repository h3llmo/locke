import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang } from "../i18n/index.tsx";

/** Per-device display preferences (theme, language). Kept in localStorage: a convenience, never user data. */
export type ThemePref = "system" | "dark" | "light";
export type LangPref = Lang | "system";
interface Prefs { theme: ThemePref; lang: LangPref }
const KEY = "locke.prefs";
const DEFAULTS: Prefs = { theme: "system", lang: "system" };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

const Ctx = createContext<{ prefs: Prefs; set(p: Partial<Prefs>): void }>({ prefs: DEFAULTS, set: () => {} });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);
  const set = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep in memory */ }
      return next;
    });
  useTheme(prefs.theme);
  return <Ctx.Provider value={{ prefs, set }}>{children}</Ctx.Provider>;
}
export const usePrefs = () => useContext(Ctx);

/** Theme = class on <html> (`lk lk-dark` / `lk lk-light`); "system" follows prefers-color-scheme. */
function useTheme(pref: ThemePref) {
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const dark = pref === "dark" || (pref === "system" && !mq.matches);
      document.documentElement.className = `lk ${dark ? "lk-dark" : "lk-light"}`;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0D1117" : "#F3F5F8");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
}
