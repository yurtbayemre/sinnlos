import type { Route } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { OrgEditor } from "@/components/manage/org-editor";
import { loadOrgEditable } from "@/lib/loaders/manage/org";
import { getViewer } from "@/lib/viewer";

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata() {
  const t = await getTranslations("manage.org");
  return { title: t("departmentTitle") };
}

export default async function EditPage({ params }: Props) {
  const { slug } = await params;
  const t = await getTranslations("manage.org");
  const load = await loadOrgEditable("department", slug, await getViewer());
  if (load.state === "notFound") notFound();
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("departmentTitle")}
        back={`/departments/${slug}` as Route}
        backLabel={load.state === "ok" ? load.editable.name : t("back")}
      />
      {load.state === "failed" ? (
        <FetchErrorBanner />
      ) : (
        <OrgEditor key={load.editable.documentId} type="department" editable={load.editable} />
      )}
    </div>
  );
}
