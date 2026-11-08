import { retry } from "@ilven/common";
import type { StorageConfig } from "./store.ts";

/**
 * Locke is an Ilven integration: it registers itself with Nevli (app secret, trust on first use) and receives its
 * object storage from the platform (one private bucket, a key limited to it).
 */
export async function registerWithNevli(nevli: string, appSecret: string, mcpUrl: string): Promise<void> {
  await retry("Nevli registration", async () => {
    const res = await fetch(`${nevli}/internal/apps/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "locke", name: "Locke", mcpUrl, baseUrl: "/apps/locke/", secret: appSecret }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

export async function storageFromNevli(nevli: string, appSecret: string): Promise<StorageConfig> {
  return retry("object storage", async () => {
    const res = await fetch(`${nevli}/internal/apps/storage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "locke", secret: appSecret }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as StorageConfig;
  });
}
