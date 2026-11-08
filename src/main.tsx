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

const auth = await initAuth({ requireLogin: true });

createRoot(document.getElementById("root")!).render(
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
