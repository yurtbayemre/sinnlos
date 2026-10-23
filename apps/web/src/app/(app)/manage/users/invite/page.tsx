import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { UserInviteForm } from "@/components/manage/user-invite-form";
import { LOCAL_ENABLED } from "@/lib/auth-config";
import { loadOrgOptions } from "@/lib/loaders/manage/org";
import { manageGate } from "@/lib/manage/page-gate";

export async function generateMetadata() {
  const t = await getTranslations("manage.users");
  return { title: t("invite.title") };
}

// LOCAL_ENABLED is a runtime env decision.
export const dynamic = "force-dynamic";

/**
 * Invitations for admin_role (v0.27): new local accounts that set their
 * password from a mail link. Only while local sign-in is on; with an
 * identity provider alone, accounts come from its sign-in.
 */
export default async function InviteUsersPage() {
  const { capabilities } = await manageGate();
  if (!capabilities.users.manage || !LOCAL_ENABLED) redirect("/manage/users");
  const [t, options] = await Promise.all([getTranslations("manage.users"), loadOrgOptions("team")]);
  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={t("invite.title")}
        description={t("invite.description")}
        back="/manage/users"
        backLabel={t("title")}
      />
      <UserInviteForm options={options} />
    </div>
  );
}
