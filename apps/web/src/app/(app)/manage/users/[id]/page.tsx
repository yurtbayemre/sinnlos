import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { UserEditor } from "@/components/manage/user-editor";
import { loadOrgOptions } from "@/lib/loaders/manage/org";
import { loadUserDetail } from "@/lib/loaders/manage/users";
import { manageGate } from "@/lib/manage/page-gate";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.users");
  return { title: t("editTitle") };
}

/** One user for admin_role (v0.23). */
export default async function EditUserPage({ params }: Props) {
  const { capabilities } = await manageGate();
  if (!capabilities.users.manage) redirect("/manage");
  const { id } = await params;
  // The team form's lists: departments and the directory (blocked accounts left out).
  const [t, load, options] = await Promise.all([
    getTranslations("manage.users"),
    loadUserDetail(id),
    loadOrgOptions("team"),
  ]);
  if (load.state === "notFound") notFound();
  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={load.state === "ok" ? load.user.displayName : t("editTitle")}
        back="/manage/users"
        backLabel={t("title")}
      />
      {load.state === "failed" ? (
        <FetchErrorBanner />
      ) : (
        <UserEditor key={load.user.id} user={load.user} options={options} />
      )}
    </div>
  );
}
