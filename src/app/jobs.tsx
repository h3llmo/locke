import { useCallback, useEffect, useRef, useState } from "react";
import type { IlvenAuth } from "@ilven/web-auth";
import { refreshJobsSummary, useAuth, VAULT_URL } from "./session.tsx";
import { useAssistantChanges } from "./assistant.ts";

/** Locke's jobs as the API returns them (server/api.ts toView). Content (prompt, style…) comes from `summary`. */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "expired";
export interface Job {
  id: string; type: "generate" | "face_swap" | "enhance" | "blur" | "upscale"; status: JobStatus; test: boolean;
  summary: {
    title?: string; style?: string; aspect?: string; mode?: string; count?: number; references?: number;
    positive?: string[]; negative?: string[]; characters?: number; worker?: string;
    names?: string[]; character?: string; prompt?: string; schedule?: string; workflow?: string; vaultItem?: string; strength?: number; level?: string; scale?: number;
  } | null;
  progress: number | null; attempt: number; queuePosition: number | null; failureCode: string | null;
  resultCount: number | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  expiresAt: string | null; cancelRequested: boolean; scheduleId: string | null; workflow: boolean; kept: boolean;
}
export interface Options {
  generate: { styles: { id: string; label: string }[]; counts: number[]; character: boolean; maxReferences: number } | null;
  faceSwap: { genders: string[]; ages: string[]; maxCharacters: number; maxFacesPerCharacter: number } | null;
  enhance: { strengths: string[] } | null;
  blur: object | null;
  upscale?: { scales: number[] } | null;
}

export const API = "/apps/locke/api";
export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export async function api<T>(auth: IlvenAuth, method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const r = await auth.fetch(`${API}${path}`, init);
  if (r.status === 204) return null as T;
  const data = await r.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!r.ok) throw new ApiError(data?.error ?? "error", data?.message ?? `HTTP ${r.status}`);
  return data as T;
}

/** What the live GPU workers can do. null while loading, "error" when Locke can't be reached. */
export function useOptions(): Options | null | "error" {
  const auth = useAuth();
  const [o, setO] = useState<Options | null | "error">(null);
  useEffect(() => {
    let alive = true;
    api<Options>(auth, "GET", "/options").then((v) => alive && setO(v), () => alive && setO("error"));
    return () => { alive = false; };
  }, [auth]);
  return o;
}

/**
 * The user's jobs, newest first. Polls every 3 s while one is waiting or running, every 20 s otherwise.
 * `type` filters on the client (the list is short: the last 100).
 */
export function useJobs(type?: Job["type"], schedule?: string) {
  const auth = useAuth();
  const [jobs, setJobs] = useState<Job[] | null | "error">(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    let next = 20_000;
    try {
      const { jobs: all } = await api<{ jobs: Job[] }>(auth, "GET", `/jobs?limit=${schedule ? 12 : 100}${schedule ? `&schedule=${encodeURIComponent(schedule)}` : ""}`);
      const mine = all.filter((j) => !j.test && (!type || j.type === type));
      setJobs(mine);
      if (mine.some(isActive)) next = 3000;
    } catch {
      setJobs((j) => (Array.isArray(j) ? j : "error"));
    }
    timer.current = setTimeout(() => void load(), next);
  }, [auth, type, schedule]);
  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useAssistantChanges(load);
  return { jobs, reload: load };
}

export function useJob(id: string | undefined) {
  const auth = useAuth();
  const [job, setJob] = useState<Job | null | "missing">(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!id) return;
    try {
      const j = await api<Job>(auth, "GET", `/jobs/${id}`);
      setJob(j);
      if (isActive(j)) timer.current = setTimeout(() => void load(), 3000);
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") setJob("missing");
      else timer.current = setTimeout(() => void load(), 10_000);
    }
  }, [auth, id]);
  useEffect(() => {
    setJob(null);
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);
  useAssistantChanges(load);
  return { job, reload: load };
}

// Result images are decrypted by Locke on each request: keep one blob per result for the session.
const blobs = new Map<string, Promise<Blob>>();
export function resultBlob(auth: IlvenAuth, jobId: string, n: number): Promise<Blob> {
  const k = `${jobId}/${n}`;
  let p = blobs.get(k);
  if (!p) {
    p = auth.fetch(`${API}/jobs/${jobId}/results/${n}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => blobs.delete(k));
    blobs.set(k, p);
  }
  return p;
}
export function forgetResults(jobId: string) {
  for (const k of [...blobs.keys()]) if (k.startsWith(`${jobId}/`)) blobs.delete(k);
}

/** Object URL of one result; null while loading, "error" when it can't be read. */
export function useResultUrl(jobId: string, n: number): string | null | "error" {
  const auth = useAuth();
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    let alive = true;
    let made: string | undefined;
    resultBlob(auth, jobId, n).then((b) => {
      if (!alive) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    }, () => alive && setUrl("error"));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [auth, jobId, n]);
  return url;
}

export const fileName = (job: Job, n: number, blob: Blob) => {
  const base = (job.summary?.title ?? job.type).replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().replace(/\s+/g, "-").slice(0, 60) || "locke";
  return `${base}-${n}.${blob.type === "image/jpeg" ? "jpg" : "png"}`;
};

export async function downloadResult(auth: IlvenAuth, job: Job, n: number) {
  const blob = await resultBlob(auth, job.id, n);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName(job, n, blob);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Keep = copy the result into the user's encrypted vault (conventional call with the user's own credential).
 * An edit of a vault image becomes that item's next version; anything else a new item.
 */
export async function keepResult(auth: IlvenAuth, job: Job, n: number) {
  const blob = await resultBlob(auth, job.id, n);
  if (job.summary?.vaultItem) {
    const r = await auth.fetch(`${VAULT_URL}api/items/${job.summary.vaultItem}/versions?${new URLSearchParams({ app: "locke", operation: job.type })}`, {
      method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob,
    });
    if (r.ok) return "version" as const;
    // The vault item was trashed meanwhile: keep it as a new item instead.
    if (r.status !== 404) {
      const d = await r.json().catch(() => null) as { error?: string; message?: string } | null;
      throw new ApiError(d?.error ?? "vault_error", d?.message ?? `HTTP ${r.status}`);
    }
  }
  const title = `${(job.summary?.title ?? "Locke").slice(0, 180)} · ${n}`;
  const r = await auth.fetch(`${VAULT_URL}api/items?${new URLSearchParams({ title, app: "locke" })}`, {
    method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob,
  });
  if (!r.ok) {
    const d = await r.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ApiError(d?.error ?? "vault_error", d?.message ?? `HTTP ${r.status}`);
  }
  return "item" as const;
}

export async function cancelJob(auth: IlvenAuth, id: string) {
  const j = await api<Job>(auth, "POST", `/jobs/${id}/cancel`);
  refreshJobsSummary();
  return j;
}
export async function deleteJob(auth: IlvenAuth, id: string) {
  await api<null>(auth, "DELETE", `/jobs/${id}`);
  forgetResults(id);
}
export async function submitJob(auth: IlvenAuth, form: FormData) {
  const j = await api<Job>(auth, "POST", "/jobs", form);
  refreshJobsSummary();
  return j;
}
