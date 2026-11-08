import { AwsClient } from "aws4fetch";

export interface StorageConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }

/**
 * Locke's binaries in the platform object store (Garage, S3 API, path-style). Every object Locke writes is already
 * sealed (AES-256-GCM with the job's key), so the store never holds a readable image.
 */
export class ObjectStore {
  private aws: AwsClient;
  private base: string;
  constructor(cfg: StorageConfig) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region });
    this.base = `${cfg.endpoint.replace(/\/$/, "")}/${cfg.bucket}`;
  }

  private url(key: string) {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "PUT", body: new Uint8Array(body), headers: { "content-type": "application/octet-stream" } });
    if (!res.ok) throw new Error(`object store PUT failed: HTTP ${res.status}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.aws.fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`object store GET failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`object store DELETE failed: HTTP ${res.status}`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
      const res = await this.aws.fetch(`${this.base}?${q}`);
      if (!res.ok) throw new Error(`object store LIST failed: HTTP ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(unxml(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? "") : undefined;
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.list(prefix)) await this.delete(key);
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
