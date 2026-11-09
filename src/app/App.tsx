import { Navigate, Route, Routes } from "react-router-dom";
import { MobileDock, Sidebar } from "../components/Nav.tsx";
import { AutomatePage } from "../pages/Automate.tsx";
import { CharactersPage } from "../pages/Characters.tsx";
import { CreatePage } from "../pages/Create.tsx";
import { EditorPage } from "../pages/Editor.tsx";
import { JobsPage } from "../pages/Jobs.tsx";
import { SettingsPage } from "../pages/Settings.tsx";

/**
 * Shell: sidebar / rail (≥ 640 px) or floating dock (< 640 px). The bottom-right 88 × 88 px corner is kept free
 * at every breakpoint for the assistant button the platform injects.
 */
export function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/create" replace />} />
          <Route path="/create/*" element={<CreatePage />} />
          <Route path="/jobs/*" element={<JobsPage />} />
          <Route path="/editor/*" element={<EditorPage />} />
          <Route path="/automate/*" element={<AutomatePage />} />
          <Route path="/characters/*" element={<CharactersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/create" replace />} />
        </Routes>
      </main>
      <MobileDock />
    </div>
  );
}
