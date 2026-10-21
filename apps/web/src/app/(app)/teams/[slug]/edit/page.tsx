import type { Route } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { OrgEditor } from "@/components/manage/org-editor";
import { loadOrgEditable, loadOrgOptions } from "@/lib/loaders/manage/org";
import { getViewer } from "@/lib/viewer";

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata() {
  const t = await getTranslations("manage.org");
  return { title: t("teamTitle") };
}

export default async function EditPage({ params }: Props) {
  const { slug } = await params;
  const t = await getTranslations("manage.org");
  const load = await loadOrgEditable("team", slug, await getViewer());
  if (load.state === "notFound") notFound();
  // admin_role edits the structure too (v0.22): the head/lead/member pickers.
  const options =
    load.state === "ok" && load.editable.roleClass === "moderator"
      ? await loadOrgOptions("team")
      : undefined;
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("teamTitle")}
        back={`/teams/${slug}` as Route}
        backLabel={load.state === "ok" ? load.editable.name : t("back")}
      />
      {load.state === "failed" ? (
        <FetchErrorBanner />
      ) : (
        <OrgEditor
          key={load.editable.documentId}
          type="team"
          editable={load.editable}
          options={options}
        />
      )}
    </div>
  );
}
