import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useAuth, useIsAdmin } from "../app/session.tsx";
import { ApiError, submitJob, useJobs, useOptions } from "../app/jobs.tsx";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toasts.tsx";
import { GpuNotice, JobProgress, StatusPill, useDate } from "./Jobs.tsx";

/**
 * Editor, first tool: face swap from uploaded photos. A photo, then one or more characters, each with 1–8 photos of
 * the same face (the first is the main face) and a gender/age that tells the GPU which face in the photo is theirs.
 * The vault picker, saved characters, enhance and blur come later (HANDOFF §5.3).
 */
interface Pic { file: File; url: string }
interface Character { id: number; faces: Pic[]; gender: string; age: string }
const MAX_BYTES = 25 * 1024 * 1024;
let seq = 1;

export function EditorPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const options = useOptions();
  const fs = options && options !== "error" ? options.faceSwap : null;
  const [photo, setPhoto] = useState<Pic | null>(null);
  const [chars, setChars] = useState<Character[]>([{ id: seq++, faces: [], gender: "any", age: "any" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const faceInput = useRef<HTMLInputElement>(null);
  const faceFor = useRef<number | null>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const pic = (file: File): Pic | null => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast(t("create.refs.type")); return null; }
    if (file.size > MAX_BYTES) { toast(t("create.refs.size")); return null; }
    const url = URL.createObjectURL(file);
    urls.current.add(url);
    return { file, url };
  };
  const maxFaces = fs?.maxFacesPerCharacter ?? 8;
  const addFaces = (id: number, files: FileList | null) => {
    if (!files) return;
    setChars((cs) => cs.map((c) => {
      if (c.id !== id) return c;
      const faces = [...c.faces];
      for (const f of Array.from(files)) {
        if (faces.length >= maxFaces) { toast(t("editor.faces.max", { n: maxFaces })); break; }
        const p = pic(f);
        if (p) faces.push(p);
      }
      return { ...c, faces };
    }));
  };
  const update = (id: number, p: Partial<Character>) => setChars((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const makeMain = (id: number, i: number) => setChars((cs) => cs.map((c) => (c.id === id ? { ...c, faces: [c.faces[i]!, ...c.faces.filter((_, k) => k !== i)] } : c)));
  const removeFace = (id: number, i: number) => setChars((cs) => cs.map((c) => (c.id === id ? { ...c, faces: c.faces.filter((_, k) => k !== i) } : c)));

  const ready = !!fs && !!photo && chars.every((c) => c.faces.length > 0) && !busy;
  const run = async () => {
    if (!ready || !photo) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("target", photo.file, photo.file.name);
    const characters = chars.map((c, ci) => {
      const faces = c.faces.map((f, fi) => {
        const name = `c${ci + 1}f${fi + 1}`;
        form.set(name, f.file, f.file.name);
        return name;
      });
      return { gender: c.gender, age: c.age, faces, mainFace: faces[0] };
    });
    form.set("params", JSON.stringify({ type: "face_swap", image: "target", characters }));
    try {
      const job = await submitJob(auth, form);
      toast(t("create.queued"), { label: t("create.view"), run: () => nav(`/jobs/${job.id}`) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("create.error.send"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={t("editor.title")}>
      <GpuNotice />
      {options === "error" && <p className="hint hint-error">{t("jobs.error")}</p>}
      {options && options !== "error" && !fs && (
        <div className="app-notice" role="status">
          <Icon name="gpuOffline" />
          <span className="t-body-s c2">{t(isAdmin ? "editor.noWorker.admin" : "editor.noWorker")}</span>
        </div>
      )}

      <div className="app-editor">
        <section className="card app-stack" aria-labelledby="fs-photo">
          <h2 className="t-title-s" id="fs-photo">{t("editor.photo")}</h2>
          {photo ? (
            <div className="tile app-photo">
              <img src={photo.url} alt={t("editor.photo")} />
              <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("editor.photo.change")} onClick={() => photoInput.current?.click()}><Icon name="upload" size={16} /></button>
            </div>
          ) : (
            <button type="button" className="tile app-photo app-ref-add" onClick={() => photoInput.current?.click()}>
              <Icon name="upload" /><span className="t-body-s c2">{t("editor.photo.pick")}</span>
            </button>
          )}
          <input ref={photoInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { const p = pic(f); if (p) setPhoto(p); } e.target.value = ""; }} />
        </section>

        <section className="card app-stack" aria-labelledby="fs-chars">
          <div className="app-row">
            <h2 className="t-title-s app-grow-0" id="fs-chars">{t("editor.faceswap")}</h2>
            <span className="app-grow-0" />
            <span className="lockcue"><Icon name="lock" size={16} />{t("privacy.private")}</span>
          </div>
          <p className="hint">{t("editor.faceswap.hint")}</p>

          {chars.map((c, ci) => (
            <div key={c.id} className="app-char">
              <div className="app-row">
                <span className="t-label">{t("editor.character", { n: ci + 1 })}</span>
                <span className="app-grow-0" />
                {chars.length > 1 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChars(chars.filter((x) => x.id !== c.id))}>{t("workers.remove")}</button>}
              </div>
              <div className="app-refs">
                {c.faces.map((f, i) => (
                  <div key={f.url} className={`tile app-ref ${i === 0 ? "is-on" : ""}`}>
                    <button type="button" className="app-ref-btn" aria-label={i === 0 ? t("editor.face.main") : t("editor.face.makeMain")} onClick={() => makeMain(c.id, i)}>
                      <img src={f.url} alt="" />
                    </button>
                    {i === 0 && <span className="tile-tag">{t("editor.face.mainTag")}</span>}
                    <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("editor.face.remove")} onClick={() => removeFace(c.id, i)}><Icon name="close" size={16} /></button>
                  </div>
                ))}
                {c.faces.length < maxFaces && (
                  <button type="button" className="tile app-ref app-ref-add" onClick={() => { faceFor.current = c.id; faceInput.current?.click(); }}>
                    <Icon name="upload" /><span className="t-caption">{t("editor.faces.add")}</span>
                  </button>
                )}
              </div>
              <span className="hint">{t("editor.faces.hint")}</span>
              <div className="app-row">
                <span className="field-label app-fieldw">{t("editor.gender")}</span>
                <div className="seg seg-sm">
                  {(fs?.genders ?? ["any"]).map((g) => <button key={g} type="button" aria-pressed={c.gender === g} onClick={() => update(c.id, { gender: g })}>{t(`editor.gender.${g}` as MessageKey)}</button>)}
                </div>
              </div>
              <div className="app-row">
                <span className="field-label app-fieldw">{t("editor.age")}</span>
                <div className="seg seg-sm">
                  {(fs?.ages ?? ["any"]).map((a) => <button key={a} type="button" aria-pressed={c.age === a} onClick={() => update(c.id, { age: a })}>{t(`editor.age.${a}` as MessageKey)}</button>)}
                </div>
              </div>
            </div>
          ))}
          <input ref={faceInput} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(e) => { if (faceFor.current != null) addFaces(faceFor.current, e.target.files); e.target.value = ""; }} />
          {chars.length < (fs?.maxCharacters ?? 1) && (
            <button type="button" className="btn btn-ghost btn-sm app-addfrag" onClick={() => setChars([...chars, { id: seq++, faces: [], gender: "any", age: "any" }])}>
              <Icon name="plus" size={16} />{t("editor.character.add")}
            </button>
          )}
          {chars.length > 1 && <p className="hint">{t("editor.characters.hint")}</p>}
        </section>
      </div>

      <div className="app-runbar">
        {error && <p className="hint hint-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready} onClick={() => void run()}>
          <Icon name="characters" />{t(busy ? "create.sending" : "editor.swap")}
        </button>
      </div>

      <RecentSwaps />
    </Page>
  );
}

function RecentSwaps() {
  const { t } = useI18n();
  const { jobs } = useJobs("face_swap");
  const when = useDate();
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  return (
    <section className="app-stack-s" aria-labelledby="fs-recent">
      <h2 className="t-title-s" id="fs-recent">{t("editor.recent")}</h2>
      <ul className="app-joblist" role="list">
        {jobs.slice(0, 5).map((j) => (
          <li key={j.id}>
            <Link className="app-jobrow" to={`/jobs/${j.id}`}>
              <span className="app-jobrow-text">
                <span className="t-body-s clamp1">{t("jobs.type.face_swap")} · {t("jobs.characters", { n: j.summary?.characters ?? 1 })}</span>
                <span className="t-caption">{when(j.createdAt)}</span>
                <JobProgress job={j} />
              </span>
              <StatusPill job={j} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
