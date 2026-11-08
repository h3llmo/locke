import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/**
 * Toasts: inverse surface, pill, 5 s, at most one action, never steal focus (polite live region).
 * Placed bottom-centre above the dock on mobile, bottom-left on desktop: never in the assistant corner.
 */
interface Toast { id: number; text: string; action?: { label: string; run(): void } }
const Ctx = createContext<(text: string, action?: Toast["action"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const show = useCallback((text: string, action?: Toast["action"]) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, ...(action ? { action } : {}) }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="app-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <span>{t.text}</span>
            {t.action && (
              <a href="#" onClick={(e) => { e.preventDefault(); t.action!.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
                {t.action.label}
              </a>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
