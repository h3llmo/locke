import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth } from "../app/session.tsx";
import { ApiError, useOptions } from "../app/jobs.tsx";
import {
  addFace, createCharacter, deleteCharacter, faceUrl, forgetBlob, removeFace, updateCharacter, useCharacters, type Age, type Character, type Gender,
} from "../app/data.tsx";
import { EmptyState, Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { AuthImg, Sheet } from "../components/Shared.tsx";
import { VaultPicker } from "../components/VaultPicker.tsx";
import { useToast } from "../components/Toasts.tsx";

/**
 * Characters (HANDOFF §5.5): keep the same face across images. A name, which face in a photo is theirs (gender and
 * age, used by the GPU to pick the face to replace) and up to 8 photos of that face; the first is the main face.
 * `?new=1&back=/editor` opens a new character and returns there when done.
 */
const GENDERS: Gender[] = ["any", "woman", "man"];
const AGES: Age[] = ["any", "child", "teen", "young", "adult", "senior"];
const MAX_FACES = 8;
const MAX_BYTES = 25 * 1024 * 1024;

export function CharactersPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, reload, set } = useCharacters();
  const [open, setOpen] = useState<string | "new" | null>(params.get("new") ? "new" : null);
  const back = params.get("back");
  const list = Array.isArray(data) ? data : [];
  const current = open && open !== "new" ? list.find((c) => c.id === open) ?? null : null;

  const close = () => {
    setOpen(null);
    if (back && /^\/[a-z]/.test(back)) nav(back);
    else if (params.get("new")) setParams({}, { replace: true });
  };
  const onChange = (c: Character | null, removedId?: string) => {
    if (c) set((x) => (Array.isArray(x) ? (x.some((y) => y.id === c.id) ? x.map((y) => (y.id === c.id ? c : y)) : [...x, c]) : [c]));
    if (removedId) set((x) => (Array.isArray(x) ? x.filter((y) => y.id !== removedId) : x));
  };

  return (
    <Page title={t("characters.title")} actions={list.length > 0 && <button type="button" className="icon-btn" aria-label={t("characters.new")} onClick={() => setOpen("new")}><Icon name="plus" /></button>}>
      {data === null && <div className="app-chargrid">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 150, borderRadius: 18 }} />)}</div>}
      {data === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {Array.isArray(data) && data.length === 0 && (
        <EmptyState icon="characters" text={t("characters.empty")}>
          <button type="button" className="btn btn-primary" onClick={() => setOpen("new")}><Icon name="plus" />{t("characters.new")}</button>
        </EmptyState>
      )}
      {list.length > 0 && (
        <ul className="app-chargrid" role="list">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className="app-charcard" onClick={() => setOpen(c.id)}>
                {c.faces[0] ? <AuthImg url={faceUrl(c.id, c.faces[0].id)} alt="" className="app-charcover" /> : <span className="app-charcover app-charcover-empty"><Icon name="characters" /></span>}
                <span className="t-body-s clamp1">{c.name}</span>
                <span className={`t-caption ${c.faces.length < 2 ? "app-warn" : ""}`}>
                  {c.faces.length < 2 ? t("characters.faces.few", { n: c.faces.length }) : t("characters.faces.n", { n: c.faces.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open === "new" && <NewCharacter onClose={close} onCreated={(c) => { onChange(c); setOpen(c.id); }} />}
      {current && <EditCharacter character={current} onClose={close} onChange={onChange} reload={reload} />}
    </Page>
  );
}

function NewCharacter({ onClose, onCreated }: { onClose(): void; onCreated(c: Character): void }) {
  const { t } = useI18n();
  const auth = useAuth();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { onCreated(await createCharacter(auth, { name: name.trim(), gender: "any", age: "any" })); }
    catch (e) { setError(e instanceof ApiError ? e.message : t("jobs.error")); }
    finally { setBusy(false); }
  };
  return (
    <Sheet title={t("characters.new")} onClose={onClose} footer={
      <button type="button" className="btn btn-primary btn-block" disabled={!name.trim() || busy} onClick={() => void create()}>{t("characters.create")}</button>
    }>
      <label className="field">
        <span className="field-label">{t("characters.name")}</span>
        <input className="input" value={name} maxLength={60} autoFocus placeholder={t("characters.name.placeholder")}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
      </label>
      {error && <p className="hint hint-error" role="alert">{error}</p>}
    </Sheet>
  );
}

function EditCharacter({ character: c, onClose, onChange, reload }: {
  character: Character; onClose(): void; onChange(c: Character | null, removed?: string): void; reload(): Promise<void>;
}) {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const options = useOptions();
  const fs = options && options !== "error" ? options.faceSwap : null;
  const [name, setName] = useState(c.name);
  const [busy, setBusy] = useState(0);
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const patch = async (b: Parameters<typeof updateCharacter>[2]) => {
    try { onChange(await updateCharacter(auth, c.id, b)); } catch (e) { toast(e instanceof ApiError ? e.message : t("jobs.error")); }
  };
  const upload = async (files: Blob[]) => {
    let left = MAX_FACES - c.faces.length;
    if (files.length > left) toast(t("editor.faces.max", { n: MAX_FACES }));
    setBusy((n) => n + 1);
    try {
      for (const f of files) {
        if (left-- <= 0) break;
        if (!/^image\/(png|jpeg)$/.test(f.type)) { toast(t("create.refs.type")); continue; }
        if (f.size > MAX_BYTES) { toast(t("create.refs.size")); continue; }
        onChange(await addFace(auth, c.id, f));
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t("jobs.error"));
      void reload();
    } finally { setBusy((n) => n - 1); }
  };
  const remove = async (face: string) => {
    try { onChange(await removeFace(auth, c.id, face)); forgetBlob(faceUrl(c.id, face)); } catch { toast(t("jobs.error")); }
  };
  const destroy = async () => {
    try { await deleteCharacter(auth, c.id); onChange(null, c.id); onClose(); } catch { toast(t("jobs.error")); }
  };
  // Only the values the GPU can match (any connected worker); "Any" always.
  const genders = GENDERS.filter((g) => g === "any" || !fs || fs.genders.includes(g) || c.gender === g);
  const ages = AGES.filter((a) => a === "any" || !fs || fs.ages.includes(a) || c.age === a);

  return (
    <Sheet title={c.name} onClose={onClose} footer={
      <div className="app-row">
        {confirmDelete ? (
          <>
            <span className="t-caption">{t("characters.delete.confirm")}</span>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void destroy()}>{t("common.delete")}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("workers.cancel")}</button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>{t("common.delete")}</button>
        )}
        <span className="app-grow-0" />
        <button type="button" className="btn btn-primary" onClick={onClose}>{t("workers.key.done")}</button>
      </div>
    }>
      <label className="field">
        <span className="field-label">{t("characters.name")}</span>
        <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name.trim() !== c.name) void patch({ name: name.trim() }); else setName(c.name); }} />
      </label>
      <p className="hint">{t("characters.match.hint")}</p>
      <div className="app-row">
        <span className="field-label app-fieldw">{t("editor.gender")}</span>
        <div className="seg seg-sm">
          {genders.map((g) => <button key={g} type="button" aria-pressed={c.gender === g} onClick={() => void patch({ gender: g })}>{t(`editor.gender.${g}` as MessageKey)}</button>)}
        </div>
      </div>
      <div className="app-row">
        <span className="field-label app-fieldw">{t("editor.age")}</span>
        <div className="seg seg-sm">
          {ages.map((a) => <button key={a} type="button" aria-pressed={c.age === a} onClick={() => void patch({ age: a })}>{t(`editor.age.${a}` as MessageKey)}</button>)}
        </div>
      </div>

      <div className="app-row">
        <span className="field-label">{t("characters.photos")}</span>
        <span className="t-caption t-num">{c.faces.length} / {MAX_FACES}</span>
      </div>
      <div className="app-refs">
        {c.faces.map((f, i) => (
          <div key={f.id} className={`tile app-ref ${i === 0 ? "is-on" : ""}`}>
            <button type="button" className="app-ref-btn" aria-label={i === 0 ? t("editor.face.main") : t("editor.face.makeMain")}
              onClick={() => i > 0 && void patch({ faceOrder: [f.id, ...c.faces.filter((x) => x.id !== f.id).map((x) => x.id)] })}>
              <AuthImg url={faceUrl(c.id, f.id)} alt="" />
            </button>
            {i === 0 && <span className="tile-tag">{t("editor.face.mainTag")}</span>}
            <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("editor.face.remove")} onClick={() => void remove(f.id)}><Icon name="close" size={16} /></button>
          </div>
        ))}
        {busy > 0 && <div className="tile app-ref skel" />}
      </div>
      <p className="hint">{t("characters.photos.hint")}</p>
      {c.faces.length < MAX_FACES && (
        <div className="app-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => input.current?.click()}><Icon name="upload" size={16} />{t("characters.photos.upload")}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPicker(true)}><Icon name="vault" size={16} />{t("picker.fromVault")}</button>
        </div>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {picker && <VaultPicker max={MAX_FACES - c.faces.length} onClose={() => setPicker(false)} onPick={(p) => void upload(p.map((x) => x.file))} />}
    </Sheet>
  );
}
