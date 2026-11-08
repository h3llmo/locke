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

/** Jobs summary for the global indicator. The job queue arrives in a later step: idle until then. */
export interface JobsSummary { running: number; queued: number; worker: "online" | "busy" | "offline" | "unknown"; unseen: number }
export function useJobsSummary(): JobsSummary {
  return { running: 0, queued: 0, worker: "unknown", unseen: 0 };
}
