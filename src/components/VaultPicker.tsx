import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { useAuth, VAULT_URL } from "../app/session.tsx";
import { ApiError } from "../app/jobs.tsx";
import {
  authBlob, sourceItemUrl, sourceQuery, vaultItems, vaultItemUrl, vaultSources, type SourceItem, type VaultItem, type VaultSource,
} from "../app/data.tsx";
import { AuthImg, Sheet } from "./Shared.tsx";
import { Icon } from "./Icon.tsx";

/**
 * Pick images from Locke Vault: the vault's own items, or any of its read-only sources (Documents, Locke's results,
 * iCloud…). PNG and JPEG only (what the GPU takes). With `stage`, a picked source image is first copied into the
 * vault (HANDOFF §5.3), so edits become versions of that vault item.
 */
export interface Picked { file: File; vaultItem?: string }
const OK_TYPE = /^image\/(png|jpeg)$/;

export function VaultPicker({ max, stage, onPick, onClose }: { max: number; stage?: boolean; onPick(p: Picked[]): void; onClose(): void }) {
  const { t } = useI18n();
  const auth = useAuth();
  const [sources, setSources] = useState<VaultSource[] | null>(null);
  const [tab, setTab] = useState("vault");
  const [collection, setCollection] = useState<string | null>(null);
  const [items, setItems] = useState<{ key: string; url: string; name: string; item?: VaultItem; ref?: string }[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { vaultSources(auth).then((s) => setSources(s.filter((x) => x.available && x.status === "ready")), () => setSources([])); }, [auth]);

  const src = sources?.find((s) => s.id === tab);
  const noAll = src?.allCollections === false && src.collections.length > 0;
  const coll = collection ?? (noAll ? src!.collections[0]!.id : null);
  const load = async (more: boolean) => {
    setError(null);
    try {
      if (tab === "vault") {
        const r = await vaultItems(auth, more ? cursor ?? undefined : undefined);
        const list = r.items.filter((i) => OK_TYPE.test(i.versions[i.versions.length - 1]?.contentType ?? "")).map((i) => ({ key: `v:${i.id}`, url: vaultItemUrl(i.id), name: i.title, item: i }));
        setItems((x) => (more && x ? [...x, ...list] : list));
        setCursor(r.cursor);
      } else {
        const r = await sourceQuery(auth, tab, { ...(coll ? { collection: coll } : {}), ...(more && cursor ? { cursor } : {}) });
        const list = r.items.filter((i: SourceItem) => !i.contentType || OK_TYPE.test(i.contentType))
          .map((i) => ({ key: `s:${tab}:${i.ref}`, url: sourceItemUrl(tab, i.ref), name: i.name, ref: i.ref }));
        setItems((x) => (more && x ? [...x, ...list] : list));
        setCursor(r.cursor);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("picker.error"));
      if (!more) setItems([]);
    }
  };
  useEffect(() => { setItems(null); setCursor(null); void load(false); }, [tab, coll]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => {
    if (max === 1) { setPicked([key]); return; }
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= max ? p : [...p, key]));
  };
  const confirm = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const out: Picked[] = [];
      for (const key of picked) {
        const it = items.find((i) => i.key === key);
        if (!it) continue;
        let vaultItem = it.item?.id;
        let url = it.url;
        if (!vaultItem && stage && it.ref) {
          // Copy the source image into the vault first; edits then become its versions.
          const r = await auth.fetch(`${VAULT_URL}api/items/from-source`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: tab, ref: it.ref }),
          });
          const d = await r.json().catch(() => null) as { id?: string; error?: string; message?: string } | null;
          if (!r.ok || !d?.id) throw new ApiError(d?.error ?? "vault_error", d?.message ?? t("picker.error"));
          vaultItem = d.id;
          url = vaultItemUrl(d.id);
        }
        const blob = await authBlob(auth, url);
        if (!OK_TYPE.test(blob.type)) throw new ApiError("type", t("create.refs.type"));
        out.push({ file: new File([blob], `${it.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 60) || "image"}.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type }), ...(vaultItem ? { vaultItem } : {}) });
      }
      onPick(out);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("picker.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("picker.title")} onClose={onClose} wide footer={
      <div className="app-row">
        <span className="t-caption">{max > 1 ? t("picker.count", { n: picked.length, max }) : ""}</span>
        <span className="app-grow-0" />
        <button type="button" className="btn btn-primary" disabled={!picked.length || busy} onClick={() => void confirm()}>
          {t(busy ? "picker.loading" : "picker.use", { n: Math.max(1, picked.length) })}
        </button>
      </div>
    }>
      <div className="hscroll app-chips" role="tablist" aria-label={t("picker.sources")}>
        <button type="button" role="tab" className="chip chip-sm" aria-selected={tab === "vault"} aria-pressed={tab === "vault"} onClick={() => { setTab("vault"); setCollection(null); }}>{t("picker.vault")}</button>
        {(sources ?? []).map((s) => (
          <button key={s.id} type="button" role="tab" className="chip chip-sm" aria-selected={tab === s.id} aria-pressed={tab === s.id} onClick={() => { setTab(s.id); setCollection(null); }}>{s.name}</button>
        ))}
      </div>
      {src && src.filters.collection && src.collections.length > 0 && (
        <select className="input app-select" value={coll ?? ""} aria-label={t("picker.collection")} onChange={(e) => setCollection(e.target.value || null)}>
          {!noAll && <option value="">{t("picker.collection.all")}</option>}
          {src.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {error && <p className="hint hint-error" role="alert">{error}</p>}
      {items === null && <div className="app-pickgrid">{Array.from({ length: 9 }, (_, i) => <div key={i} className="tile skel app-picktile" />)}</div>}
      {items && items.length === 0 && !error && <p className="hint">{t(tab === "vault" ? "picker.empty.vault" : "picker.empty")}</p>}
      {items && items.length > 0 && (
        <div className="app-pickgrid">
          {items.map((i) => {
            const n = picked.indexOf(i.key);
            return (
              <button key={i.key} type="button" className={`tile app-picktile ${n >= 0 ? "is-on" : ""}`} aria-pressed={n >= 0} aria-label={i.name} onClick={() => toggle(i.key)}>
                <AuthImg url={i.url} alt="" />
                {n >= 0 && <span className="tile-tag">{max > 1 ? n + 1 : <Icon name="check" size={16} />}</span>}
              </button>
            );
          })}
        </div>
      )}
      {cursor && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load(true)}>{t("picker.more")}</button>}
    </Sheet>
  );
}
