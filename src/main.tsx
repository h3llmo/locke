import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { initAuth } from "@ilven/web-auth";
import "./styles/locke.css";
import { App } from "./app/App.tsx";
import { PrefsProvider, usePrefs } from "./app/prefs.tsx";
import { SessionProvider } from "./app/session.tsx";
import { I18nProvider, resolveLang } from "./i18n/index.tsx";
import { ToastProvider } from "./components/Toasts.tsx";
import type { ReactNode } from "react";

function Localized({ children }: { children: ReactNode }) {
  const { prefs } = usePrefs();
  const lang = resolveLang(prefs.lang);
  document.documentElement.lang = lang;
  return <I18nProvider lang={lang}>{children}</I18nProvider>;
}

/** If start-up fails, say so instead of leaving a blank page (e.g. sign-in needs HTTPS outside localhost). */
function fatal(err: unknown) {
  const fr = navigator.languages.some((l) => l.toLowerCase().startsWith("fr"));
  const insecure = !window.isSecureContext;
  const box = document.createElement("div");
  box.className = "card app-fatal";
  const h = document.createElement("h1");
  h.className = "t-title-m";
  h.textContent = fr ? "Locke n'a pas pu démarrer" : "Locke couldn't start";
  const p = document.createElement("p");
  p.className = "t-body c2";
  p.textContent = insecure
    ? fr ? "La connexion sécurisée exige HTTPS. Ouvrez Locke via son adresse https." : "Signing in requires HTTPS. Open Locke through its https address."
    : fr ? "La connexion a échoué. Réessayez dans un instant." : "Signing in failed. Try again in a moment.";
  const b = document.createElement("button");
  b.className = "btn btn-primary";
  b.textContent = fr ? "Réessayer" : "Try again";
  b.onclick = () => location.reload();
  box.append(h, p, b);
  document.getElementById("root")!.replaceChildren(box);
  console.error(err);
}

const auth = await initAuth({ requireLogin: true }).catch((e: unknown) => { fatal(e); return null; });
if (auth) createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrefsProvider>
      <Localized>
        <SessionProvider auth={auth}>
          <ToastProvider>
            <BrowserRouter basename="/apps/locke">
              <App />
            </BrowserRouter>
          </ToastProvider>
        </SessionProvider>
      </Localized>
    </PrefsProvider>
  </StrictMode>,
);
