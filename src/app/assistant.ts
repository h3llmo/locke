import { useEffect } from "react";
import type { IlvenAuth } from "@ilven/web-auth";
import { refreshJobsSummary } from "./session.tsx";

/**
 * The Ilven assistant (platform UI-Plugin, CLAUDE.md §4.4). Locke works fully without it: if the plugin can't load,
 * nothing changes. It acts only through the user's Locke connex (Locke's MCP tools), never through this page.
 * Pages tell it what's on screen (page context); after it acts, Locke's lists reload.
 */
const context = new Map<string, unknown>();
export const CHANGED = "locke:changed";

/** Declare part of the page context while a component is shown (e.g. the photo open in the editor). */
export function useAssistantContext(key: string, value: unknown) {
  const json = JSON.stringify(value ?? null);
  useEffect(() => {
    context.set(key, value);
    return () => { context.delete(key); };
  }, [key, json]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Reload lists when the assistant changed something (jobs, schedules, workflows, vault). */
export function useAssistantChanges(reload: () => unknown) {
  useEffect(() => {
    const on = () => { void reload(); };
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [reload]);
}

let mounted = false;
export function mountAssistant(auth: IlvenAuth) {
  if (mounted) return;
  mounted = true;
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/plugin/ilven-plugin.js";
  script.onload = () => {
    const a = document.createElement("ilven-assistant") as HTMLElement & { tokenProvider?: unknown; contextProvider?: unknown };
    a.setAttribute("app", "locke");
    a.tokenProvider = () => auth.getToken();
    a.contextProvider = () => ({
      app: "Locke (AI photo studio)",
      page: location.pathname.replace(/^\/apps\/locke/, "") || "/",
      ...Object.fromEntries(context),
    });
    a.addEventListener("ilven:actions", () => {
      refreshJobsSummary();
      window.dispatchEvent(new Event(CHANGED));
    });
    document.body.append(a);
  };
  script.onerror = () => script.remove();
  document.head.append(script);
}
