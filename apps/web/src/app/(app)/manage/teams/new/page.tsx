import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { OrgEditor } from "@/components/manage/org-editor";
import { loadOrgOptions } from "@/lib/loaders/manage/org";
import { manageGate } from "@/lib/manage/page-gate";

export async function generateMetadata() {
  const t = await getTranslations("manage.org");
  return { title: t("newTeam") };
}

/** A new team (v0.22): admin_role only, like every structural change. */
export default async function NewTeamPage() {
  const { capabilities } = await manageGate();
  if (!capabilities.org.manage) redirect("/manage");
  const [t, options] = await Promise.all([getTranslations("manage.org"), loadOrgOptions("team")]);
  return (
    <div className="space-y-8">
      <ManagePageHeader title={t("newTeam")} back="/teams" backLabel={t("teams")} />
      <OrgEditor type="team" editable={null} options={options} />
    </div>
  );
}
