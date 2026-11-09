import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, scheduleSpecSchema } from "./schedule.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

test("schedules: minutes and hourly", () => {
  assert.equal(iso(nextRun({ repeat: "minutes", every: 15, tz: "UTC" }, at("2026-11-09T10:07:30Z"))), "2026-11-09T10:15:00.000Z");
  assert.equal(iso(nextRun({ repeat: "minutes", every: 1, tz: "UTC" }, at("2026-11-09T10:15:00Z"))), "2026-11-09T10:16:00.000Z");
  assert.equal(iso(nextRun({ repeat: "hourly", minute: 30, tz: "Europe/Brussels" }, at("2026-11-09T10:31:00Z"))), "2026-11-09T11:30:00.000Z");
  // Half-hour zones: minute 0 local is :30 UTC.
  assert.equal(iso(nextRun({ repeat: "hourly", minute: 0, tz: "Asia/Kolkata" }, at("2026-11-09T10:00:00Z"))), "2026-11-09T10:30:00.000Z");
});

test("schedules: daily and weekly wall-clock times, across DST", () => {
  const daily = { repeat: "daily" as const, times: ["07:00", "19:00"], tz: "Europe/Brussels" };
  assert.equal(iso(nextRun(daily, at("2026-11-09T05:00:00Z"))), "2026-11-09T06:00:00.000Z"); // 07:00 CET
  assert.equal(iso(nextRun(daily, at("2026-11-09T06:00:00Z"))), "2026-11-09T18:00:00.000Z");
  assert.equal(iso(nextRun(daily, at("2026-11-09T18:30:00Z"))), "2026-11-10T06:00:00.000Z");
  // Summer time (CEST): 07:00 = 05:00Z; the day after the switch to winter time: 06:00Z.
  assert.equal(iso(nextRun(daily, at("2026-10-24T12:00:00Z"))), "2026-10-24T17:00:00.000Z");
  assert.equal(iso(nextRun(daily, at("2026-10-25T00:00:00Z"))), "2026-10-25T06:00:00.000Z");
  // 02:30 does not exist on 2026-03-29 in Brussels: shifted by the jump (03:30 CEST = 01:30Z).
  assert.equal(iso(nextRun({ repeat: "daily", times: ["02:30"], tz: "Europe/Brussels" }, at("2026-03-28T23:00:00Z"))), "2026-03-29T01:30:00.000Z");
  // Weekly: Mondays (1) at 09:00 New York. 2026-11-09 is a Monday.
  const weekly = { repeat: "weekly" as const, weekdays: [1], times: ["09:00"], tz: "America/New_York" };
  assert.equal(iso(nextRun(weekly, at("2026-11-09T13:00:00Z"))), "2026-11-09T14:00:00.000Z");
  assert.equal(iso(nextRun(weekly, at("2026-11-09T14:00:00Z"))), "2026-11-16T14:00:00.000Z");
});

test("schedules: spec validation", () => {
  assert.ok(scheduleSpecSchema.safeParse({ repeat: "daily", times: ["07:00"], tz: "Europe/Paris" }).success);
  assert.ok(!scheduleSpecSchema.safeParse({ repeat: "daily", times: ["7:00"], tz: "Europe/Paris" }).success);
  assert.ok(!scheduleSpecSchema.safeParse({ repeat: "daily", times: ["07:00"], tz: "Mars/Olympus" }).success);
  assert.ok(!scheduleSpecSchema.safeParse({ repeat: "minutes", every: 2, tz: "UTC" }).success);
});
