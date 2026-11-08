import { useI18n } from "../i18n/index.tsx";
import { EmptyState, Page } from "../components/Page.tsx";

/** Placeholders until each area is built (HANDOFF §10 order). Each already sits in the final shell. */
export function CreatePage() {
  const { t } = useI18n();
  return <Page title={t("create.title")}><EmptyState icon="create" text={t("create.empty")}><p className="t-caption">{t("page.soon")}</p></EmptyState></Page>;
}
export function JobsPage() {
  const { t } = useI18n();
  return <Page title={t("jobs.title")}><EmptyState icon="jobs" text={t("jobs.empty")} /></Page>;
}
export function EditorPage() {
  const { t } = useI18n();
  return <Page title={t("editor.title")}><EmptyState icon="editor" text={t("editor.empty")}><p className="t-caption">{t("page.soon")}</p></EmptyState></Page>;
}
export function AutomatePage() {
  const { t } = useI18n();
  return <Page title={t("automate.title")}><EmptyState icon="automate" text={t("automate.empty")}><p className="t-caption">{t("page.soon")}</p></EmptyState></Page>;
}
export function CharactersPage() {
  const { t } = useI18n();
  return <Page title={t("characters.title")}><EmptyState icon="characters" text={t("characters.empty")}><p className="t-caption">{t("page.soon")}</p></EmptyState></Page>;
}
