import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { UserAccountActions } from "@/components/manage/user-account-actions";
import { UserDataProtection } from "@/components/manage/user-data-protection";
import { UserEditor } from "@/components/manage/user-editor";
import { LOCAL_ENABLED } from "@/lib/auth-config";
import { loadOrgOptions } from "@/lib/loaders/manage/org";
import { loadUserDetail } from "@/lib/loaders/manage/users";
import { manageGate } from "@/lib/manage/page-gate";
import { isOff } from "@/lib/switches";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.users");
  return { title: t("editTitle") };
}

/**
 * One user for admin_role (v0.23). v0.28: the data-protection section
 * (export, training evidence, anonymisation); an anonymised account shows
 * that section only: none of its fields can change any more.
 */
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
        <>
          {!load.user.anonymisedAt && (
            <>
              <UserAccountActions user={load.user} localSignIn={LOCAL_ENABLED} />
              <UserEditor key={load.user.id} user={load.user} options={options} />
            </>
          )}
          <UserDataProtection user={load.user} trainingEvidence={!isOff("training")} />
        </>
      )}
    </div>
  );
}
