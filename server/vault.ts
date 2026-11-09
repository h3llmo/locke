import { HttpError } from "@ilven/common";

/**
 * Locke's server-side calls to Locke Vault, made for one user with Locke's delegated key for that user (Nevli,
 * audience locke-vault + the services the vault reads sources from). Used by workflows only: interactive calls go
 * from the browser with the user's own login.
 */
export class VaultError extends HttpError {}

export interface SourceInfo {
  id: string; available: boolean; name: string; status: string;
  filters: { addedAfter: boolean; collection: boolean };
  collections: { id: string; name: string }[];
}
export interface SourceItem { ref: string; name: string; addedAt?: string; date?: string }

export class VaultClient {
  constructor(private base: string, private key: string) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => { throw new VaultError(503, "vault_unavailable", "Locke Vault is not reachable"); });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      const code = res.status === 401 ? "automation_revoked" : body?.error ?? `vault_${res.status}`;
      throw new VaultError(res.status, code, body?.message ?? `Locke Vault answered HTTP ${res.status}`);
    }
    return res;
  }
  private json = async <T>(path: string, init?: RequestInit) => (await (await this.call(path, init)).json()) as T;
  private post = <T>(path: string, body: unknown) =>
    this.json<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  quota() { return this.json<{ used: number; limit: number }>("/quota"); }
  async sources() { return (await this.json<{ sources: SourceInfo[] }>("/sources")).sources; }
  query(source: string, q: Record<string, unknown>) {
    return this.post<{ items: SourceItem[]; cursor: string | null }>(`/sources/${encodeURIComponent(source)}/query`, q);
  }
  stage(source: string, ref: string) { return this.post<{ id: string }>("/items/from-source", { source, ref }); }
  async content(itemId: string): Promise<Buffer> {
    return Buffer.from(await (await this.call(`/items/${encodeURIComponent(itemId)}/content`)).arrayBuffer());
  }
  addVersion(itemId: string, bytes: Buffer, type: string, operation: string, note?: string) {
    const q = new URLSearchParams({ app: "locke", operation, ...(note ? { note } : {}) });
    return this.json<{ id: string }>(`/items/${encodeURIComponent(itemId)}/versions?${q}`, {
      method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes),
    });
  }
}
