import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/index.tsx";
import { useAuth } from "../app/session.tsx";
import { authBlob, faceUrl, type Character } from "../app/data.tsx";
import { Icon } from "./Icon.tsx";

/** An image behind the user's login, loaded when it scrolls into view. */
export function AuthImg({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const auth = useAuth();
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null | "error">(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (!("IntersectionObserver" in window)) { setSeen(true); return; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    let made: string | undefined;
    authBlob(auth, url).then((b) => { if (alive) { made = URL.createObjectURL(b); setSrc(made); } }, () => alive && setSrc("error"));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [auth, url, seen]);
  if (src && src !== "error") return <img src={src} alt={alt} className={className} />;
  return <span ref={ref} className={`app-imgph ${src === "error" ? "" : "skel"} ${className ?? ""}`} aria-hidden="true">{src === "error" && <Icon name="close" size={16} />}</span>;
}

/**
 * Modal surface: a bottom sheet on phones, a centred dialog from 640 px. Escape and the scrim close it; focus moves in
 * and comes back to where it was.
 */
export function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      // Only the topmost sheet reacts (a picker can open over an editor).
      const all = document.querySelectorAll(".app-sheet");
      if (all[all.length - 1] !== box.current) return;
      if (e.key === "Escape") close.current();
      if (e.key === "Tab" && box.current) {
        const f = box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea, select, a[href], [tabindex='0']");
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; before?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per opening; onClose changes identity each render
  return (
    <div className="app-modal" role="presentation">
      <div className="scrim app-modal-scrim" onClick={onClose} />
      <div ref={box} tabIndex={-1} className={`sheet app-sheet ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="grabber app-phone-only" />
        <div className="app-row app-sheet-head">
          <h2 className="t-title-s">{title}</h2>
          <span className="app-grow-0" />
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="app-sheet-body">{children}</div>
        {footer && <div className="app-sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Round character covers (main face). Multi or single select with aria-pressed. */
export function CharacterBubbles({ characters, selected, onToggle, extra }: {
  characters: Character[]; selected: string[]; onToggle(id: string): void; extra?: ReactNode;
}) {
  return (
    <div className="hscroll app-bubbles" role="group">
      {characters.map((c) => (
        <button key={c.id} type="button" className="bubble" aria-pressed={selected.includes(c.id)} onClick={() => onToggle(c.id)}>
          {c.faces[0] ? <AuthImg url={faceUrl(c.id, c.faces[0].id)} alt="" /> : <span className="bubble-face app-bubble-empty"><Icon name="characters" /></span>}
          {selected.includes(c.id) && <span className="bubble-check"><Icon name="check" size={16} /></span>}
          <span className="clamp1">{c.name}</span>
        </button>
      ))}
      {extra}
    </div>
  );
}
