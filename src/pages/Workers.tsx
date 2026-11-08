import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth } from "../app/session.tsx";
import { useToast } from "../components/Toasts.tsx";

/**
 * GPU workers (admins): partner apps such as windows-pilot that pull Locke jobs (docs/worker-api.md).
 * A worker key is shown once; the worker's public key is trusted on first use, any later change needs approval here.
 */
interface Worker {
  id: string; name: string; mode: "test" | "live"; enabled: boolean;
  keyStatus: "waiting_for_worker" | "active" | "pending_approval";
  fingerprint: string | null; pendingFingerprint: string | null;
  state: "online" | "busy" | "paused" | "offline";
  software: { name: string; version: string } | null; gpu: { name: string; vramMb: number } | null;
  lastSeenAt: string | null;
}
interface TestJob { id: string; status: string; failureCode: string | null }

const API = "/apps/locke/api/admin/workers";
const statePill: Record<Worker["state"], string> = { online: "pill-success", busy: "pill-info", paused: "pill-warning", offline: "pill-muted" };

export function GpuWorkers() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const [workers, setWorkers] = useState<Worker[] | null | "error">(null);
  const [name, setName] = useState("windows-pilot");
  const [shownKey, setShownKey] = useState<{ worker: string; key: string } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; what: "rotate" | "remove" } | null>(null);
  const [tests, setTests] = useState<Record<string, TestJob>>({});

  const load = useCallback(async () => {
    const r = await auth.fetch(API);
    setWorkers(r.ok ? ((await r.json()) as { workers: Worker[] }).workers : "error");
  }, [auth]);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const send = async (method: string, url: string, body?: unknown) => {
    const r = await auth.fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) toast((data as { message?: string } | null)?.message ?? t("workers.error"));
    return r.ok ? data : null;
  };

  const add = async () => {
    const d = (await send("POST", API, { name: name.trim() || "GPU worker", mode: "test" })) as { worker: Worker; workerKey: string } | null;
    if (d) { setShownKey({ worker: d.worker.name, key: d.workerKey }); await load(); }
  };
  const rotate = async (w: Worker) => {
    const d = (await send("POST", `${API}/${w.id}/rotate-key`)) as { workerKey: string } | null;
    setConfirm(null);
    if (d) { setShownKey({ worker: w.name, key: d.workerKey }); await load(); }
  };
  const remove = async (w: Worker) => { setConfirm(null); await send("DELETE", `${API}/${w.id}`); await load(); };
  const patch = async (w: Worker, body: Partial<Pick<Worker, "mode" | "enabled">>) => { if (await send("PATCH", `${API}/${w.id}`, body)) await load(); };
  const approve = async (w: Worker) => { if (await send("POST", `${API}/${w.id}/approve-key`, { fingerprint: w.pendingFingerprint })) await load(); };

  const testJob = async (w: Worker) => {
    const job = (await send("POST", `${API}/${w.id}/test-job`)) as TestJob | null;
    if (!job) return;
    setTests((x) => ({ ...x, [w.id]: job }));
    // Follow it for up to 3 minutes.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await auth.fetch(`/apps/locke/api/jobs/${job.id}`);
      if (!r.ok) return;
      const j = (await r.json()) as TestJob;
      setTests((x) => ({ ...x, [w.id]: j }));
      if (!["queued", "running"].includes(j.status)) return;
    }
  };

  const copy = (key: string) => {
    navigator.clipboard.writeText(key).then(() => toast(t("workers.key.copied")), () => toast(t("workers.key.copyFailed")));
  };

  return (
    <section className="card app-stack" aria-labelledby="workers-title">
      <h2 className="t-title-s" id="workers-title">{t("workers.title")}</h2>
      <p className="hint">{t("workers.hint")}</p>

      {shownKey && (
        <div className="app-keybox" role="alert">
          <span className="t-label">{t("workers.key.title", { name: shownKey.worker })}</span>
          <code className="app-key">{shownKey.key}</code>
          <span className="hint">{t("workers.key.once")}</span>
          <div className="app-row">
            <button type="button" className="btn btn-secondary" onClick={() => copy(shownKey.key)}>{t("workers.key.copy")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setShownKey(null)}>{t("workers.key.done")}</button>
          </div>
        </div>
      )}

      {workers === "error" && <p className="hint">{t("workers.error")}</p>}
      {workers === null && <div className="skel" style={{ height: 56, borderRadius: 12 }} />}
      {Array.isArray(workers) && workers.length > 0 && (
        <ul className="app-workers">
          {workers.map((w) => {
            const test = tests[w.id];
            return (
              <li key={w.id} className="app-worker">
                <div className="app-row">
                  <span className="t-label">{w.name}</span>
                  <span className={`pill ${statePill[w.state]}`}>{t(`workers.state.${w.state}` as MessageKey)}</span>
                  <span className="pill">{t(w.mode === "live" ? "workers.mode.live" : "workers.mode.test")}</span>
                  {!w.enabled && <span className="pill pill-warning">{t("workers.disabled")}</span>}
                </div>
                <span className="t-caption c2">
                  {[w.software && `${w.software.name} ${w.software.version}`, w.gpu?.name].filter(Boolean).join(" · ") || t("workers.noHello")}
                </span>
                {w.keyStatus === "waiting_for_worker" && <span className="t-caption c2">{t("workers.key.waiting")}</span>}
                {w.fingerprint && <span className="t-caption c2">{t("workers.fingerprint")} <code>{w.fingerprint}</code></span>}
                {w.keyStatus === "pending_approval" && (
                  <div className="app-row">
                    <span className="t-caption">{t("workers.key.pending")} <code>{w.pendingFingerprint}</code></span>
                    <button type="button" className="btn btn-secondary" onClick={() => void approve(w)}>{t("workers.key.approve")}</button>
                  </div>
                )}
                {test && (
                  <span className="t-caption" role="status">
                    {t("workers.test.status", { status: t(`workers.test.${test.status}` as MessageKey) })}
                    {test.failureCode ? ` (${test.failureCode})` : ""}
                  </span>
                )}
                {confirm?.id === w.id ? (
                  <div className="app-row">
                    <span className="t-caption">{t(confirm.what === "rotate" ? "workers.confirm.rotate" : "workers.confirm.remove")}</span>
                    <button type="button" className="btn btn-secondary" onClick={() => void (confirm.what === "rotate" ? rotate(w) : remove(w))}>
                      {t(confirm.what === "rotate" ? "workers.rotate" : "workers.remove")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>{t("workers.cancel")}</button>
                  </div>
                ) : (
                  <div className="app-row">
                    <button type="button" className="btn btn-secondary" disabled={w.keyStatus !== "active"} onClick={() => void testJob(w)}>{t("workers.test")}</button>
                    <button type="button" className="btn btn-ghost" onClick={() => void patch(w, { mode: w.mode === "live" ? "test" : "live" })}>
                      {t(w.mode === "live" ? "workers.toTest" : "workers.toLive")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => void patch(w, { enabled: !w.enabled })}>
                      {t(w.enabled ? "workers.disable" : "workers.enable")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirm({ id: w.id, what: "rotate" })}>{t("workers.rotate")}</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirm({ id: w.id, what: "remove" })}>{t("workers.remove")}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="app-row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="field-label" htmlFor="worker-name">{t("workers.name")}</label>
        <input id="worker-name" className="input app-grow" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary">{t("workers.add")}</button>
      </form>
    </section>
  );
}
