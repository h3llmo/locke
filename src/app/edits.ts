import { useCallback, useEffect, useRef, useState } from "react";
import type { IlvenAuth } from "@ilven/web-auth";
import { refreshJobsSummary, useAuth, VAULT_URL } from "./session.tsx";
import { useAssistantChanges } from "./assistant.ts";
import { api, API, ApiError } from "./jobs.tsx";
import type { WorkflowStep } from "./data.tsx";

/**
 * Edits (server/edits.ts): several steps on one photo, in the user's order, as one thing. Each step runs as a hidden
 * GPU job; only the final result is offered.
 */
export interface Edit {
  id: string; status: "running" | "done" | "failed" | "cancelled"; steps: WorkflowStep[]; step: number;
  /** "2:no_face_found": step 3 (0-based 2) found no face and was skipped. */
  notes: string[]; failure: string | null;
  vaultItem: string | null; vaultVersion: number | null; operation: string;
  current: { status: "queued" | "running" | string; progress: number | null; queuePosition: number | null } | null;
  result: { format: string; width: number; height: number; bytes: number } | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; expiresAt: string | null;
}
export const editRunning = (e: Edit) => e.status === "running";
export const skippedSteps = (e: Edit) => new Set(e.notes.map((n) => Number(n.split(":")[0])));

export async function submitEdit(auth: IlvenAuth, photo: File, steps: WorkflowStep[], vault?: { item: string; version?: number }) {
  const form = new FormData();
  form.set("params", JSON.stringify({ image: "photo", steps, ...(vault ? { vaultItem: vault.item, ...(vault.version ? { vaultVersion: vault.version } : {}) } : {}) }));
  form.set("photo", photo, photo.name);
  const e = await api<Edit>(auth, "POST", "/edits", form);
  refreshJobsSummary();
  return e;
}
export const cancelEdit = async (auth: IlvenAuth, id: string) => { const e = await api<Edit>(auth, "POST", `/edits/${id}/cancel`); refreshJobsSummary(); return e; };
export const deleteEdit = async (auth: IlvenAuth, id: string) => { await api<null>(auth, "DELETE", `/edits/${id}`); forgetEdit(id); };

/** The user's edits, newest first. Polls every 3 s while one runs, every 20 s otherwise. */
export function useEdits(limit = 50) {
  const auth = useAuth();
  const [edits, setEdits] = useState<Edit[] | null | "error">(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    let next = 20_000;
    try {
      const { edits: all } = await api<{ edits: Edit[] }>(auth, "GET", `/edits?limit=${limit}`);
      setEdits(all);
      if (all.some(editRunning)) next = 3000;
    } catch {
      setEdits((x) => (Array.isArray(x) ? x : "error"));
    }
    timer.current = setTimeout(() => void load(), next);
  }, [auth, limit]);
  useEffect(() => { void load(); return () => clearTimeout(timer.current); }, [load]);
  useAssistantChanges(load);
  return { edits, reload: load };
}

export function useEdit(id: string | undefined) {
  const auth = useAuth();
  const [edit, setEdit] = useState<Edit | null | "missing">(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!id) return;
    try {
      const e = await api<Edit>(auth, "GET", `/edits/${id}`);
      setEdit(e);
      if (editRunning(e)) timer.current = setTimeout(() => void load(), 3000);
    } catch (x) {
      if (x instanceof ApiError && x.code === "not_found") setEdit("missing");
      else timer.current = setTimeout(() => void load(), 10_000);
    }
  }, [auth, id]);
  useEffect(() => { setEdit(null); void load(); return () => clearTimeout(timer.current); }, [load]);
  useAssistantChanges(load);
  return { edit, reload: load };
}

// Images are decrypted by Locke on each request: one blob per edit image for the session.
const blobs = new Map<string, Promise<Blob>>();
export function editBlob(auth: IlvenAuth, id: string, which: "original" | "result"): Promise<Blob> {
  const k = `${id}/${which}`;
  let p = blobs.get(k);
  if (!p) {
    p = auth.fetch(`${API}/edits/${id}/images/${which}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => blobs.delete(k));
    blobs.set(k, p);
  }
  return p;
}
function forgetEdit(id: string) { for (const k of [...blobs.keys()]) if (k.startsWith(`${id}/`)) blobs.delete(k); }

export function useEditImage(id: string, which: "original" | "result", enabled = true): string | null | "error" {
  const auth = useAuth();
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let made: string | undefined;
    editBlob(auth, id, which).then((b) => { if (alive) { made = URL.createObjectURL(b); setUrl(made); } }, () => alive && setUrl("error"));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [auth, id, which, enabled]);
  return url;
}

export async function downloadEdit(auth: IlvenAuth, e: Edit) {
  const blob = await editBlob(auth, e.id, "result");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `locke-${e.operation}.${blob.type === "image/jpeg" ? "jpg" : "png"}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Keep = copy the final result into the user's vault: an edit of a vault photo becomes ONE new version of it
 * ("Undo last step" in the vault removes the whole edit); an uploaded photo becomes a new vault item.
 */
export async function keepEdit(auth: IlvenAuth, e: Edit, title: string): Promise<{ how: "version" | "item"; item: string; version: number | null }> {
  const blob = await editBlob(auth, e.id, "result");
  const fail = async (r: Response) => {
    const d = await r.json().catch(() => null) as { error?: string; message?: string } | null;
    return new ApiError(d?.error ?? "vault_error", d?.message ?? `HTTP ${r.status}`);
  };
  if (e.vaultItem) {
    const r = await auth.fetch(`${VAULT_URL}api/items/${e.vaultItem}/versions?${new URLSearchParams({ app: "locke", operation: e.operation })}`, {
      method: "POST", headers: { "content-type": blob.type || "image/jpeg" }, body: blob,
    });
    if (r.ok) {
      const d = await r.json().catch(() => null) as { currentVersion?: number; version?: { n: number }; n?: number } | null;
      return { how: "version", item: e.vaultItem, version: d?.currentVersion ?? d?.version?.n ?? d?.n ?? null };
    }
    if (r.status !== 404) throw await fail(r); // trashed meanwhile: a new item instead
  }
  const r = await auth.fetch(`${VAULT_URL}api/items?${new URLSearchParams({ title: title.slice(0, 200), app: "locke" })}`, {
    method: "POST", headers: { "content-type": blob.type || "image/jpeg" }, body: blob,
  });
  if (!r.ok) throw await fail(r);
  const d = await r.json().catch(() => null) as { id?: string } | null;
  return { how: "item", item: d?.id ?? "", version: 1 };
}
