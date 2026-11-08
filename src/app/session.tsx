import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { IlvenAuth } from "@ilven/web-auth";

/** The signed-in user (Ilven SSO). Locke calls its own API and Locke Vault with the user's own credential. */
const Ctx = createContext<IlvenAuth | null>(null);
export function SessionProvider({ auth, children }: { auth: IlvenAuth; children: ReactNode }) {
  return <Ctx.Provider value={auth}>{children}</Ctx.Provider>;
}
export function useAuth(): IlvenAuth {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAuth outside SessionProvider");
  return a;
}

export const VAULT_URL = "/apps/locke-vault/";
export interface Quota { used: number; limit: number }

/** Vault quota (used / 256 MB). null while loading, "error" if the vault can't be reached. */
export function useQuota(): Quota | null | "error" {
  const auth = useAuth();
  const [q, setQ] = useState<Quota | null | "error">(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      auth.fetch(`${VAULT_URL}api/quota`)
        .then((r) => (r.ok ? (r.json() as Promise<Quota>) : Promise.reject(new Error(String(r.status)))))
        .then((v) => alive && setQ(v), () => alive && setQ("error"));
    void load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [auth]);
  return q;
}

/** Jobs summary for the global indicator, from Locke's API. One shared poll for every component that shows it. */
export interface JobsSummary { running: number; queued: number; worker: "online" | "busy" | "paused" | "offline" | "unknown"; unseen: number }
const IDLE: JobsSummary = { running: 0, queued: 0, worker: "unknown", unseen: 0 };
let summary = IDLE;
const listeners = new Set<() => void>();
let poller: ReturnType<typeof setInterval> | undefined;
let reload: (() => void) | undefined;

/** Refresh the indicator now (after submitting or cancelling a job) instead of at the next 15 s poll. */
export function refreshJobsSummary() { reload?.(); }

function startPolling(auth: IlvenAuth) {
  if (poller) return;
  const load = () =>
    auth.fetch("/apps/locke/api/worker-status")
      .then((r) => (r.ok ? (r.json() as Promise<{ status: JobsSummary["worker"]; workers: number; queued: number; running: number }>) : Promise.reject(new Error(String(r.status)))))
      .then((s) => {
        summary = { running: s.running, queued: s.queued, worker: s.workers ? s.status : "unknown", unseen: 0 };
        listeners.forEach((l) => l());
      }, () => {});
  reload = () => void load();
  void load();
  poller = setInterval(load, 15_000);
}

export function useJobsSummary(): JobsSummary {
  const auth = useAuth();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    startPolling(auth);
    return () => { listeners.delete(l); };
  }, [auth]);
  return summary;
}

/** True when the signed-in user is an Ilven admin (Locke shows admin settings). */
export function useIsAdmin(): boolean {
  const auth = useAuth();
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    auth.fetch("/apps/locke/api/me").then((r) => (r.ok ? r.json() : { isAdmin: false })).then((m: { isAdmin: boolean }) => alive && setAdmin(m.isAdmin), () => {});
    return () => { alive = false; };
  }, [auth]);
  return admin;
}
