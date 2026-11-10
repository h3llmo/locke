import { useCallback, useEffect, useRef, useState } from "react";
import type { IlvenAuth } from "@ilven/web-auth";
import { useAuth, VAULT_URL } from "./session.tsx";
import { api, API, ApiError } from "./jobs.tsx";
import { useAssistantChanges } from "./assistant.ts";

/** Saved characters, prompts and workflows (Locke's API), and what the vault offers (the vault's API). */
export type Gender = "any" | "woman" | "man";
export type Age = "any" | "child" | "teen" | "young" | "adult" | "senior";
export interface Character { id: string; name: string; gender: Gender; age: Age; faces: { id: string }[]; createdAt: string; updatedAt: string }
export interface PromptFrag { text: string; on: boolean }
export interface ScheduleSpecBase { tz: string }
export type ScheduleSpec = ScheduleSpecBase & (
  | { repeat: "minutes"; every: 1 | 5 | 10 | 15 | 30 }
  | { repeat: "hourly"; minute: number }
  | { repeat: "daily"; times: string[] }
  | { repeat: "weekly"; weekdays: number[]; times: string[] }
);
export interface Schedule {
  id: string; spec: ScheduleSpec; active: boolean; keepResults: boolean; nextRunAt: string | null; lastRunAt: string | null;
  runCount: number; skippedCount: number; lastError: string | null;
}
export interface SavedPrompt {
  id: string; name: string; positive: PromptFrag[]; negative: PromptFrag[]; style: string; aspect: "square" | "portrait" | "landscape";
  count: number; mode: "fast" | "quality"; character: string | null; references: { id: string }[]; schedule: Schedule | null;
  createdAt: string; updatedAt: string;
}
/** One step on a photo (Editor edits and workflows share them; any order). */
export type Level = "subtle" | "balanced" | "strong";
export type WorkflowStep =
  | { op: "face_swap"; characters: string[] } | { op: "enhance"; strength: Level } | { op: "upscale"; scale: 2 | 4 } | { op: "blur"; strength: number };
export interface WorkflowData {
  name: string; sources: { source: string; collection: string | null; label: string }[]; steps: WorkflowStep[];
}
export interface Workflow extends WorkflowData {
  id: string; active: boolean; activatedAt: string | null; lastCheckAt: string | null; lastError: string | null; createdAt: string;
  stats: { pending: number; running: number; waitingForGpu: number; done: number; doneToday: number; failed: number; failedToday: number; lastDoneAt: string | null };
}
export interface WorkflowRun {
  id: string; source: string; status: "pending" | "running" | "done" | "failed"; itemId: string | null; step: number;
  jobStatus: string | null; notes: string[]; failure: string | null; createdAt: string; updatedAt: string;
}
export interface Automation { enabled: boolean; working?: boolean; since?: string }

export interface VaultItem { id: string; title: string; currentVersion: number | null; versions: { n: number; contentType: string; operation: string; app: string; createdAt: string }[]; updatedAt: string }
export interface VaultSource {
  id: string; available: boolean; name: string; description: string; status: "ready" | "needs_setup" | "not_allowed"; experimental: boolean;
  filters: { collection: boolean; addedAfter: boolean }; collections: { id: string; name: string }[];
  /** false: the source has no "everything" view (iCloud reads only the albums the user chose); pick a collection. */
  allCollections?: boolean;
}
export interface SourceItem { ref: string; name: string; contentType?: string; date?: string }

/** A list from the API, reloadable. null while loading, "error" when it can't be read. */
function useList<T>(load: (auth: IlvenAuth) => Promise<T>, deps: unknown[] = []) {
  const auth = useAuth();
  const [v, setV] = useState<T | null | "error">(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try { const x = await load(auth); if (alive.current) setV(x); } catch { if (alive.current) setV((p) => (p && p !== "error" ? p : "error")); }
  }, [auth, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { alive.current = true; void reload(); return () => { alive.current = false; }; }, [reload]);
  useAssistantChanges(reload);
  return { data: v, reload, set: setV };
}

export const useCharacters = () => useList(async (a) => (await api<{ characters: Character[] }>(a, "GET", "/characters")).characters);
export const usePrompts = () => useList(async (a) => (await api<{ prompts: SavedPrompt[] }>(a, "GET", "/prompts")).prompts);
export const useWorkflows = () => useList(async (a) => (await api<{ workflows: Workflow[] }>(a, "GET", "/workflows")).workflows);
export const useAutomation = () => useList((a) => api<Automation>(a, "GET", "/automation"));

// ---------- characters ----------
export const createCharacter = (a: IlvenAuth, b: { name: string; gender: Gender; age: Age }) => api<Character>(a, "POST", "/characters", b);
export const updateCharacter = (a: IlvenAuth, id: string, b: Partial<{ name: string; gender: Gender; age: Age; faceOrder: string[] }>) =>
  api<Character>(a, "PATCH", `/characters/${id}`, b);
export const deleteCharacter = (a: IlvenAuth, id: string) => api<null>(a, "DELETE", `/characters/${id}`);
export async function addFace(a: IlvenAuth, id: string, file: Blob) {
  const r = await a.fetch(`${API}/characters/${id}/faces`, { method: "POST", headers: { "content-type": file.type || "image/jpeg" }, body: file });
  const d = await r.json().catch(() => null) as (Character & { error?: string; message?: string }) | null;
  if (!r.ok) throw new ApiError(d?.error ?? "error", d?.message ?? `HTTP ${r.status}`);
  return d as Character;
}
export const removeFace = (a: IlvenAuth, id: string, face: string) => api<Character>(a, "DELETE", `/characters/${id}/faces/${face}`);
export const faceUrl = (id: string, face: string) => `${API}/characters/${id}/faces/${face}`;

// ---------- prompts and schedules ----------
export interface PromptBody { name: string; positive: PromptFrag[]; negative: PromptFrag[]; style: string; aspect: string; count: number; mode: string; character: string | null }
export function savePrompt(a: IlvenAuth, id: string | null, body: PromptBody, refs: Blob[]) {
  const form = new FormData();
  form.set("params", JSON.stringify({ ...body, references: refs.map((_, i) => `ref${i + 1}`) }));
  refs.forEach((r, i) => form.set(`ref${i + 1}`, r, `ref${i + 1}`));
  return api<SavedPrompt>(a, id ? "PUT" : "POST", id ? `/prompts/${id}` : "/prompts", form);
}
export const deletePrompt = (a: IlvenAuth, id: string) => api<null>(a, "DELETE", `/prompts/${id}`);
export const runPrompt = (a: IlvenAuth, id: string) => api<{ jobId: string }>(a, "POST", `/prompts/${id}/run`);
export const refUrl = (id: string, ref: string) => `${API}/prompts/${id}/references/${ref}`;
export const setSchedule = (a: IlvenAuth, id: string, b: { spec: ScheduleSpec; active: boolean; keepResults: boolean }) =>
  api<SavedPrompt>(a, "PUT", `/prompts/${id}/schedule`, b);
export const deleteSchedule = (a: IlvenAuth, id: string) => api<SavedPrompt>(a, "DELETE", `/prompts/${id}/schedule`);

// ---------- automation and workflows ----------
export const enableAutomation = (a: IlvenAuth) => api<Automation>(a, "POST", "/automation");
export const disableAutomation = (a: IlvenAuth) => api<Automation>(a, "DELETE", "/automation");
export const saveWorkflow = (a: IlvenAuth, id: string | null, d: WorkflowData) => api<Workflow>(a, id ? "PUT" : "POST", id ? `/workflows/${id}` : "/workflows", d);
export const setWorkflowActive = (a: IlvenAuth, id: string, active: boolean) => api<Workflow>(a, "PATCH", `/workflows/${id}`, { active });
export const deleteWorkflow = (a: IlvenAuth, id: string) => api<null>(a, "DELETE", `/workflows/${id}`);
export const workflowRuns = async (a: IlvenAuth, id: string) => (await api<{ runs: WorkflowRun[] }>(a, "GET", `/workflows/${id}/runs`)).runs;
export const retryRun = (a: IlvenAuth, id: string, run: string) => api<{ ok: true }>(a, "POST", `/workflows/${id}/runs/${run}/retry`);

// ---------- vault (the user's own login, from the browser) ----------
const V = `${VAULT_URL}api`;
async function vault<T>(a: IlvenAuth, method: string, path: string, body?: unknown): Promise<T> {
  const r = await a.fetch(`${V}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!r.ok) throw new ApiError(d?.error ?? "vault_error", d?.message ?? `HTTP ${r.status}`);
  return d as T;
}
export const vaultItems = (a: IlvenAuth, cursor?: string) => vault<{ items: VaultItem[]; cursor: string | null }>(a, "GET", `/items?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const vaultSources = async (a: IlvenAuth) => (await vault<{ sources: VaultSource[] }>(a, "GET", "/sources")).sources;
export const sourceQuery = (a: IlvenAuth, source: string, q: { collection?: string; cursor?: string; limit?: number }) =>
  vault<{ items: SourceItem[]; cursor: string | null }>(a, "POST", `/sources/${encodeURIComponent(source)}/query`, { limit: 60, ...q });
/**
 * Image sizes: `thumb` for grids and lists, `display` to look at one image; no size = the full-size original, only
 * for downloads (GPU jobs read originals on the server, never through the browser).
 */
export type PreviewSize = "thumb" | "display";
const sized = (url: string, size?: PreviewSize, at?: string) => {
  const q = new URLSearchParams({ ...(size ? { size } : {}), ...(at ? { at: String(Date.parse(at)) } : {}) }).toString();
  return q ? `${url}?${q}` : url;
};
export const vaultItemUrl = (id: string, size?: PreviewSize) => sized(`${V}/items/${id}/content`, size);
/**
 * One version's own address: a cached image can never be an older version than the one shown. `at` (the version's
 * creation time) keeps it unique when "Undo" frees a version number that a later version reuses.
 */
export const vaultVersionUrl = (id: string, n: number, size?: PreviewSize, at?: string) => sized(`${V}/items/${id}/versions/${n}/content`, size, at);
/** The latest version of a vault item, as a preview. */
export const vaultPreviewUrl = (i: VaultItem, size: PreviewSize) => {
  const v = i.versions.find((x) => x.n === i.currentVersion);
  return v ? vaultVersionUrl(i.id, v.n, size, v.createdAt) : vaultItemUrl(i.id, size);
};
export const sourceItemUrl = (source: string, ref: string, size?: PreviewSize) => sized(`${V}/sources/${encodeURIComponent(source)}/items/${encodeURIComponent(ref)}/content`, size);
export async function addVaultVersion(a: IlvenAuth, itemId: string, blob: Blob, operation: string) {
  const r = await a.fetch(`${V}/items/${itemId}/versions?${new URLSearchParams({ app: "locke", operation })}`, {
    method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob,
  });
  if (!r.ok) {
    const d = await r.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new ApiError(d?.error ?? "vault_error", d?.message ?? `HTTP ${r.status}`);
  }
}

// ---------- authenticated images ----------
const blobs = new Map<string, Promise<Blob>>();
/** An image behind the user's login, fetched once per session (characters' faces, references, vault previews). */
export function authBlob(a: IlvenAuth, url: string): Promise<Blob> {
  let p = blobs.get(url);
  if (!p) {
    p = a.fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => blobs.delete(url));
    blobs.set(url, p);
  }
  return p;
}
export function forgetBlob(url: string) { blobs.delete(url); }

// ---------- notifications ----------
export interface Notifications { discord: { configured: false } | { configured: true; notifyFailures: boolean; lastSentAt: string | null; lastError: string | null } }
export const useNotifications = () => useList((a) => api<Notifications>(a, "GET", "/notifications"));
export const saveDiscord = (a: IlvenAuth, b: { webhookUrl?: string; notifyFailures: boolean; lang: string }) =>
  api<Notifications>(a, "PUT", "/notifications/discord", { ...b, appUrl: `${location.origin}/apps/locke` });
export const removeDiscord = (a: IlvenAuth) => api<Notifications>(a, "DELETE", "/notifications/discord");
export const testDiscord = (a: IlvenAuth) => api<Notifications>(a, "POST", "/notifications/discord/test");
