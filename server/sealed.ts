import { randomBytes } from "node:crypto";
import type { Sealer } from "@ilven/common";
import { open, seal } from "./crypto.ts";
import type { ObjectStore } from "./store.ts";

/**
 * Sealing for Locke's own records (characters, prompts, workflows). Row data: JSON sealed with Locke's master key,
 * with the row id inside so a sealed value can't be moved to another row. Photos: AES-256-GCM blobs in Garage under a
 * per-row key (itself sealed with the master key), bound to row, kind and photo id.
 */
export function sealRow(sealer: Sealer, id: string, data: object): string {
  return sealer.seal(JSON.stringify({ ...data, _id: id }));
}
export function openRow<T>(sealer: Sealer, id: string, sealed: string): T {
  const v = JSON.parse(sealer.open(sealed)) as T & { _id?: string };
  if (v._id !== id) throw new Error("sealed row does not belong to this id");
  delete v._id;
  return v;
}

export const newBlobKey = (sealer: Sealer) => sealer.seal(randomBytes(32).toString("base64"));

export class RowBlobs {
  constructor(private store: ObjectStore, private sealer: Sealer, private kind: string) {}
  private key(sealedKey: string) { return Buffer.from(this.sealer.open(sealedKey), "base64"); }
  private aad(rowId: string, blobId: string) { return `locke/v1|${this.kind}|${rowId}|${blobId}`; }
  path(rowId: string, blobId: string) { return `${this.kind}/${rowId}/${blobId}`; }

  async put(rowId: string, sealedKey: string, blobId: string, data: Buffer): Promise<number> {
    const k = this.key(sealedKey);
    try {
      const sealed = seal(k, data, this.aad(rowId, blobId));
      await this.store.put(this.path(rowId, blobId), sealed);
      return sealed.length;
    } finally { k.fill(0); }
  }
  async get(rowId: string, sealedKey: string, blobId: string): Promise<Buffer | null> {
    const blob = await this.store.get(this.path(rowId, blobId));
    if (!blob) return null;
    const k = this.key(sealedKey);
    try { return open(k, blob, this.aad(rowId, blobId)); } finally { k.fill(0); }
  }
  delete(rowId: string, blobId: string) { return this.store.delete(this.path(rowId, blobId)); }
  deleteRow(rowId: string) { return this.store.deletePrefix(`${this.kind}/${rowId}/`); }
}
