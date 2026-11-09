import { z } from "zod";

/**
 * When a schedule runs next (HANDOFF §5.1 "Repeat"). Times are wall-clock times in the user's time zone, so
 * "daily 07:00" stays 07:00 across daylight-saving changes. A wall time skipped by a spring-forward jump is shifted
 * by the jump (02:30 → 03:30).
 */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSpecSchema = z.discriminatedUnion("repeat", [
  z.object({ repeat: z.literal("minutes"), every: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]) }),
  z.object({ repeat: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  z.object({ repeat: z.literal("daily"), times: z.array(time).min(1).max(6) }),
  z.object({ repeat: z.literal("weekly"), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), times: z.array(time).min(1).max(6) }),
]).and(z.object({ tz: z.string().min(1).max(64).refine(validTz, "unknown time zone") }));
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export function validTz(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const fmt = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of an instant in a time zone. */
function parts(tz: string, at: number) {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second!, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!) };
}
const offset = (tz: string, at: number) => {
  const p = parts(tz, at);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at / 1000) * 1000;
};
/** The instant of a wall-clock time in a time zone (or the first instant after it if it doesn't exist). */
export function zonedInstant(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let at = guess - offset(tz, guess);
  at = guess - offset(tz, at);
  const p = parts(tz, at);
  if (p.h !== h || p.mi !== mi) {
    // Skipped by a DST jump: shift by the jump.
    const after = guess - offset(tz, guess + 3 * 3600_000);
    return Math.max(at, after);
  }
  return at;
}

/** Next run strictly after `after` (ms). */
export function nextRun(spec: ScheduleSpec, after: number): number {
  if (spec.repeat === "minutes") {
    const step = spec.every * 60_000;
    return Math.floor(after / step) * step + step;
  }
  const hm = spec.repeat === "hourly"
    ? Array.from({ length: 24 }, (_, h) => [h, spec.minute] as const)
    : spec.times.map((t) => [Number(t.slice(0, 2)), Number(t.slice(3))] as const);
  const days = spec.repeat === "weekly" ? new Set(spec.weekdays) : null;
  const base = parts(spec.tz, after);
  let best = Infinity;
  for (let i = 0; i < 9 && best === Infinity; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    if (days && !days.has(day.getUTCDay())) continue;
    for (const [h, mi] of hm) {
      const at = zonedInstant(spec.tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi);
      if (at > after && at < best) best = at;
    }
  }
  if (best === Infinity) throw new Error("no next run");
  return best;
}
