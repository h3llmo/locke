import { useCallback, useEffect, useRef, useState } from "react";
import type { IlvenAuth } from "@ilven/web-auth";
import { refreshJobsSummary, useAuth } from "./session.tsx";
import { useAssistantChanges } from "./assistant.ts";
import { api, API, ApiError } from "./jobs.tsx";
import type { PreviewSize, WorkflowStep } from "./data.tsx";

/**
 * Edits (server/edits.ts): several steps on one photo, in the user's order, as one thing. Each step runs as a hidden
 * GPU job; only the final result is offered.
 */
export interface Edit {
  id: string; status: "running" | "done" | "failed" | "cancelled"; steps: WorkflowStep[]; step: number;
  /** "2:no_face_found": step 3 (0-based 2) found no face and was skipped. */
  notes: string[]; failure: string | null;
  vaultItem: string | null; vaultVersion: number | null; operation: string;
  /** Where the result was kept in the vault. */
  kept: { item: string; version: number | null } | null;
  current: { status: "queued" | "running" | string; progress: number | null; queuePosition: number | null } | null;
  result: { format: string; width: number; height: number; bytes: number } | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; expiresAt: string | null;
}
export const editRunning = (e: Edit) => e.status === "running";
export const skippedSteps = (e: Edit) => new Set(e.notes.map((n) => Number(n.split(":")[0])));

/**
 * The photo of a new edit: an uploaded file, or a reference that Locke resolves on the server (a vault photo's version,
 * or a previous edit's result): full-size photos never go through the browser. `vault` also says where keeping the
 * result adds a version.
 */
export type EditSource = { file: File } | { fromEdit: string } | { vaultOnly: true };
export async function submitEdit(auth: IlvenAuth, src: EditSource, steps: WorkflowStep[], vault?: { item: string; version?: number }) {
  const form = new FormData();
  const link = vault ? { vaultItem: vault.item, ...(vault.version ? { vaultVersion: vault.version } : {}) } : {};
  form.set("params", JSON.stringify({ steps, ...link, ...("file" in src ? { image: "photo" } : "fromEdit" in src ? { fromEdit: src.fromEdit } : {}) }));
  if ("file" in src) form.set("photo", src.file, src.file.name);
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

// Images are decrypted by Locke on each request: one blob per edit image and size for the session. Pages show
// previews (`size`); only a download asks for the full-size result.
const blobs = new Map<string, Promise<Blob>>();
export function editBlob(auth: IlvenAuth, id: string, which: "original" | "result", size?: PreviewSize): Promise<Blob> {
  const k = `${id}/${which}/${size ?? "full"}`;
  let p = blobs.get(k);
  if (!p) {
    p = auth.fetch(`${API}/edits/${id}/images/${which}${size ? `?size=${size}` : ""}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => blobs.delete(k));
    blobs.set(k, p);
  }
  return p;
}
function forgetEdit(id: string) { for (const k of [...blobs.keys()]) if (k.startsWith(`${id}/`)) blobs.delete(k); }

export function useEditImage(id: string, which: "original" | "result", enabled = true, size: PreviewSize = "display"): string | null | "error" {
  const auth = useAuth();
  const [url, setUrl] = useState<string | null | "error">(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let made: string | undefined;
    editBlob(auth, id, which, size).then((b) => { if (alive) { made = URL.createObjectURL(b); setUrl(made); } }, () => alive && setUrl("error"));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [auth, id, which, enabled, size]);
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
 * Keep = Locke copies the final result into the user's vault (server to vault, with the user's own login): an edit of
 * a vault photo becomes ONE new version of it ("Undo last step" in the vault removes the whole edit); an uploaded
 * photo becomes a new vault item.
 */
export async function keepEdit(auth: IlvenAuth, e: Edit, title: string): Promise<Edit> {
  return api<Edit>(auth, "POST", `/edits/${e.id}/keep`, { title: title.slice(0, 200) });
}
