import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/index.tsx";
import { useAuth, useIsAdmin } from "../app/session.tsx";
import { ApiError, submitJob, useJobs, useOptions } from "../app/jobs.tsx";
import { useCharacters } from "../app/data.tsx";
import { useAssistantContext } from "../app/assistant.ts";
import { Page } from "../components/Page.tsx";
import { Icon } from "../components/Icon.tsx";
import { CharacterBubbles } from "../components/Shared.tsx";
import { VaultPicker } from "../components/VaultPicker.tsx";
import { useToast } from "../components/Toasts.tsx";
import { GpuNotice, JobProgress, StatusPill, useDate } from "./Jobs.tsx";

/**
 * Editor, first tool: face swap (HANDOFF §5.3). A photo (uploaded, or from the vault: then the result can be saved as
 * that vault item's next version) and one or more saved characters, matched by gender and age.
 * Enhance and blur come when a GPU offers them.
 */
interface Photo { file: File; url: string; vaultItem?: string }
const MAX_BYTES = 25 * 1024 * 1024;
// Kept while the app is open, so creating a character (another screen) doesn't lose the chosen photo.
let keptPhoto: Photo | null = null;
let keptChars: string[] = [];
type Tool = "face_swap" | "blur";
let keptTool: Tool = "face_swap";
let keptStrength = 60;

export function EditorPage() {
  const { t } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const isAdmin = useIsAdmin();
  const options = useOptions();
  const fs = options && options !== "error" ? options.faceSwap : null;
  const { data: characters } = useCharacters();
  const [photo, setPhotoState] = useState<Photo | null>(keptPhoto);
  const [chosen, setChosenState] = useState<string[]>(keptChars);
  const [tool, setToolState] = useState<Tool>(keptTool);
  const [strength, setStrengthState] = useState(keptStrength);
  const setTool = (x: Tool) => { keptTool = x; setToolState(x); setError(null); };
  const setStrength = (n: number) => { keptStrength = n; setStrengthState(n); };
  const blurOk = !!(options && options !== "error" && options.blur);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const setPhoto = (p: Photo | null) => { if (keptPhoto && keptPhoto !== p) URL.revokeObjectURL(keptPhoto.url); keptPhoto = p; setPhotoState(p); };
  const setChosen = (c: string[]) => { keptChars = c; setChosenState(c); };
  const list = Array.isArray(characters) ? characters : [];
  useAssistantContext("editor", {
    photo: photo ? (photo.vaultItem ? { vaultPhotoId: photo.vaultItem } : { notInVault: true }) : null,
    tool: tool === "blur" ? "background blur" : "face swap",
    chosenCharacters: chosen.map((id) => ({ id, name: list.find((c) => c.id === id)?.name })),
  });
  // Forget characters deleted meanwhile.
  useEffect(() => { if (Array.isArray(characters)) { const ok = chosen.filter((id) => characters.some((c) => c.id === id)); if (ok.length !== chosen.length) setChosen(ok); } }, [characters]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromFile = (file: File, vaultItem?: string) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) { toast(t("create.refs.type")); return; }
    if (file.size > MAX_BYTES) { toast(t("create.refs.size")); return; }
    setPhoto({ file, url: URL.createObjectURL(file), ...(vaultItem ? { vaultItem } : {}) });
  };
  const max = fs?.maxCharacters ?? 1;
  const toggle = (id: string) => {
    if (chosen.includes(id)) setChosen(chosen.filter((x) => x !== id));
    else if (max === 1) setChosen([id]);
    else if (chosen.length < max) setChosen([...chosen, id]);
    else toast(t("editor.characters.max", { n: max }));
  };
  const noPhotos = chosen.filter((id) => !list.find((c) => c.id === id)?.faces.length);

  const ready = !busy && !!photo && (tool === "blur" ? blurOk : !!fs && chosen.length > 0 && noPhotos.length === 0);
  const run = async () => {
    if (!ready || !photo) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("target", photo.file, photo.file.name);
    const fromVault = photo.vaultItem ? { vaultItem: photo.vaultItem } : {};
    form.set("params", JSON.stringify(tool === "blur"
      ? { type: "blur", image: "target", strength, ...fromVault }
      : { type: "face_swap", image: "target", characters: chosen.map((character) => ({ character })), ...fromVault }));
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
      {options && options !== "error" && (tool === "blur" ? !blurOk : !fs) && (
        <div className="app-notice" role="status">
          <Icon name="gpuOffline" />
          <span className="t-body-s c2">{t(tool === "blur" ? "editor.blur.unavailable" : isAdmin ? "editor.noWorker.admin" : "editor.noWorker")}</span>
        </div>
      )}

      <div className="seg" role="radiogroup" aria-label={t("editor.tool")}>
        <button type="button" role="radio" aria-checked={tool === "face_swap"} aria-pressed={tool === "face_swap"} onClick={() => setTool("face_swap")}><Icon name="characters" size={16} />{t("editor.faceswap")}</button>
        <button type="button" role="radio" aria-checked={tool === "blur"} aria-pressed={tool === "blur"} onClick={() => setTool("blur")}><Icon name="blur" size={16} />{t("editor.blur")}</button>
      </div>

      <div className="app-editor">
        <section className="card app-stack" aria-labelledby="fs-photo">
          <h2 className="t-title-s" id="fs-photo">{t("editor.photo")}</h2>
          {photo ? (
            <div className="tile app-photo">
              <img src={photo.url} alt={t("editor.photo")} />
              {photo.vaultItem && <span className="tile-tag"><Icon name="lock" size={16} />{t("editor.fromVault")}</span>}
              <button type="button" className="icon-btn on-image app-ref-remove" aria-label={t("editor.photo.remove")} onClick={() => setPhoto(null)}><Icon name="close" size={16} /></button>
            </div>
          ) : (
            <div className="app-photo-pick">
              <button type="button" className="tile app-photo app-ref-add" onClick={() => photoInput.current?.click()}>
                <Icon name="upload" /><span className="t-body-s c2">{t("editor.photo.pick")}</span>
              </button>
              <button type="button" className="tile app-photo app-ref-add" onClick={() => setPicker(true)}>
                <Icon name="vault" /><span className="t-body-s c2">{t("picker.fromVault")}</span>
              </button>
            </div>
          )}
          {photo?.vaultItem && <p className="hint">{t("editor.fromVault.hint")}</p>}
          <input ref={photoInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ""; }} />
        </section>

        {tool === "blur" ? (
        <section className="card app-stack" aria-labelledby="fs-blur">
          <div className="app-row">
            <h2 className="t-title-s app-grow-0" id="fs-blur">{t("jobs.type.blur")}</h2>
            <span className="app-grow-0" />
            <span className="lockcue"><Icon name="lock" size={16} />{t("privacy.private")}</span>
          </div>
          <label className="field">
            <span className="field-label">{t("automate.blur.strength", { n: strength })}</span>
            <input type="range" min={0} max={100} step={5} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
          </label>
          <p className="hint">{t("editor.blur.hint")}</p>
        </section>
        ) : (
        <section className="card app-stack" aria-labelledby="fs-chars">
          <div className="app-row">
            <h2 className="t-title-s app-grow-0" id="fs-chars">{t("editor.faceswap")}</h2>
            <span className="app-grow-0" />
            <span className="lockcue"><Icon name="lock" size={16} />{t("privacy.private")}</span>
          </div>
          {characters === null && <div className="app-bubbles">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ width: 56, height: 56, borderRadius: 28 }} />)}</div>}
          {Array.isArray(characters) && (
            <CharacterBubbles characters={list} selected={chosen} onToggle={toggle} extra={
              <Link className="bubble" to="/characters?new=1&back=/editor">
                <span className="bubble-face app-bubble-empty"><Icon name="plus" /></span>
                <span>{t("editor.character.new")}</span>
              </Link>
            } />
          )}
          <p className="hint">{t(list.length ? (max > 1 ? "editor.characters.pick.n" : "editor.characters.pick") : "editor.characters.none", { n: max })}</p>
          {noPhotos.length > 0 && <p className="hint hint-error">{t("editor.characters.noPhotos")}</p>}
        </section>
        )}
      </div>

      <div className="app-runbar">
        {error && <p className="hint hint-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready} onClick={() => void run()}>
          <Icon name={tool === "blur" ? "blur" : "characters"} />
          {busy ? t("create.sending") : tool === "blur" ? t("editor.blur.run") : chosen.length > 1 ? t("editor.swap.n", { n: chosen.length }) : t("editor.swap")}
        </button>
      </div>

      <RecentEdits />
      {picker && <VaultPicker max={1} stage onClose={() => setPicker(false)} onPick={(p) => { const x = p[0]; if (x) fromFile(x.file, x.vaultItem); }} />}
    </Page>
  );
}

function RecentEdits() {
  const { t } = useI18n();
  const { jobs: all } = useJobs();
  const jobs = Array.isArray(all) ? all.filter((j) => (j.type === "face_swap" || j.type === "blur") && !j.workflow) : all;
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
                <span className="t-body-s clamp1">{j.type === "blur"
                  ? `${t("editor.blur")}${j.summary?.strength !== undefined ? ` · ${t("automate.blur.strength", { n: j.summary.strength })}` : ""}`
                  : `${j.summary?.names?.join(", ") ?? t("jobs.type.face_swap")} · ${t("jobs.characters", { n: j.summary?.characters ?? 1 })}`}</span>
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
