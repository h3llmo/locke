import type { ScheduleSpec } from "./data.tsx";

type T = (key: never, vars?: Record<string, string | number>) => string;

/** "Every 15 min", "Hourly at :30", "Daily · 07:00, 19:00", "Mon, Thu · 09:00" in the user's language. */
export function describeCadence(spec: ScheduleSpec, t: T, lang: string): string {
  const tt = t as unknown as (k: string, v?: Record<string, string | number>) => string;
  if (spec.repeat === "minutes") return tt("schedule.desc.minutes", { n: spec.every });
  if (spec.repeat === "hourly") return tt("schedule.desc.hourly", { m: String(spec.minute).padStart(2, "0") });
  const times = spec.times.join(", ");
  if (spec.repeat === "daily") return tt("schedule.desc.daily", { times });
  const fmt = new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" });
  // 2026-11-08 is a Sunday (0).
  const days = [...spec.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => fmt.format(new Date(Date.UTC(2026, 10, 8 + d))));
  return tt("schedule.desc.weekly", { days: days.join(", "), times });
}

export const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};
