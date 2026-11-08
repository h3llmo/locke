import { useI18n } from "../i18n/index.tsx";
import type { Quota } from "../app/session.tsx";

/** Vault ring: grey < 85 %, amber ≥ 85 %, red at 100 %. */
export function QuotaRing({ quota, inset = "var(--surface-1)" }: { quota: Quota; inset?: string }) {
  const { t, bytes } = useI18n();
  const pct = Math.min(100, Math.round((quota.used / quota.limit) * 100));
  const colour = pct >= 100 ? "var(--danger)" : pct >= 85 ? "var(--warning)" : "var(--text-2)";
  return (
    <span className="ring" role="img" aria-label={t("vault.aria", { used: bytes(quota.used), total: bytes(quota.limit) })}
      style={{ background: `conic-gradient(${colour} ${pct}%, var(--surface-3) 0)` }}>
      <span style={{ background: inset }} aria-hidden="true">{pct}%</span>
    </span>
  );
}
