import { HttpError } from "@ilven/common";

/**
 * Locke's server-side calls to Locke Vault, always for one user: workflows use Locke's delegated key for that user
 * (Nevli, audience locke-vault + the services the vault reads sources from); edits use the user's own credential,
 * forwarded from their request (a conventional call, CLAUDE.md §5.3), so full-size photos go from the vault to Locke
 * and back without crossing the user's connection.
 */
export class VaultError extends HttpError {}

export interface SourceInfo {
  id: string; available: boolean; name: string; status: string;
  filters: { addedAfter: boolean; collection: boolean };
  collections: { id: string; name: string }[];
}
export interface SourceItem { ref: string; name: string; addedAt?: string; date?: string }

export interface VaultItemBrief { id: string; currentVersion: number | null; versions: { n: number }[] }

export class VaultClient {
  /** `user`: the key is the user's own login or API key (not Locke's delegated key). */
  constructor(private base: string, private key: string, private user = false) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => { throw new VaultError(503, "vault_unavailable", "Locke Vault is not reachable"); });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      const code = res.status === 401 ? (this.user ? "unauthorized" : "automation_revoked") : body?.error ?? `vault_${res.status}`;
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
  /** One version's original bytes (the latest when `n` is omitted), with its number. */
  async version(itemId: string, n?: number): Promise<{ bytes: Buffer; type: string; n: number }> {
    const item = await this.json<VaultItemBrief>(`/items/${encodeURIComponent(itemId)}`);
    const v = n ?? item.currentVersion;
    if (!v || !item.versions.some((x) => x.n === v)) throw new VaultError(404, "not_found", "That version of the vault photo no longer exists");
    const res = await this.call(`/items/${encodeURIComponent(itemId)}/versions/${v}/content`);
    return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "", n: v };
  }
  addVersion(itemId: string, bytes: Buffer, type: string, operation: string, note?: string) {
    const q = new URLSearchParams({ app: "locke", operation, ...(note ? { note } : {}) });
    return this.json<VaultItemBrief>(`/items/${encodeURIComponent(itemId)}/versions?${q}`, {
      method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes),
    });
  }
  newItem(bytes: Buffer, type: string, title: string) {
    return this.json<VaultItemBrief>(`/items?${new URLSearchParams({ title: title.slice(0, 200), app: "locke" })}`, {
      method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes),
    });
  }
}
