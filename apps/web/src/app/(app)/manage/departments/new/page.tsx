import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { OrgEditor } from "@/components/manage/org-editor";
import { loadOrgOptions } from "@/lib/loaders/manage/org";
import { manageGate } from "@/lib/manage/page-gate";

export async function generateMetadata() {
  const t = await getTranslations("manage.org");
  return { title: t("newDepartment") };
}

/** A new department (v0.22): admin_role only, like every structural change. */
export default async function NewDepartmentPage() {
  const { capabilities } = await manageGate();
  if (!capabilities.org.manage) redirect("/manage");
  const [t, options] = await Promise.all([
    getTranslations("manage.org"),
    loadOrgOptions("department"),
  ]);
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("newDepartment")}
        back="/departments"
        backLabel={t("departments")}
      />
      <OrgEditor type="department" editable={null} options={options} />
    </div>
  );
}
