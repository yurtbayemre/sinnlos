import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { initials } from "@/lib/utils";
import { avatarThumbUrl } from "@/lib/config";
import type { UserLite } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm, type ProfileInitial } from "@/components/profile/profile-form";
import { ChangePasswordForm } from "@/components/profile/change-password-form";

/** The slice of the GET /api/me self profile (FX02 allowlist) this page reads. */
type MeProfile = ProfileInitial & {
  username?: string | null;
  email?: string | null;
  avatar?: UserLite["avatar"];
};

export async function generateMetadata() {
  const t = await getTranslations("profile");
  return { title: t("title") };
}

export default async function ProfilePage() {
  const [t, tCommon] = await Promise.all([getTranslations("profile"), getTranslations("common")]);
  const session = await getSession();
  const isLocal = session?.provider === "local";

  const { data } = await tryFetch(() => strapi<{ data: MeProfile | null }>("/api/me"), "profile");
  // The form renders only on top of the stored profile (FX26): a form
  // prefilled with blanks after a failed read overwrote every field on
  // save. Without the profile the page shows the banner and the password
  // card only.
  const me = data?.data ?? null;

  const name = me?.displayName ?? me?.username ?? session?.user?.name ?? tCommon("unknown");
  const email = me?.email ?? session?.user?.email ?? "";
  const avatarUrl = avatarThumbUrl(me?.avatar) ?? session?.user?.image ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      {!me && <FetchErrorBanner />}

      <div className="flex items-center gap-4">
        <Avatar className="h-16 w-16">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
          <AvatarFallback className="text-xl">{initials(name)}</AvatarFallback>
        </Avatar>
        <div>
          <div className="text-lg font-semibold leading-tight">{name}</div>
          <div className="text-sm text-muted-foreground">{email}</div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {me && (
          <Card>
            <CardHeader>
              <CardTitle>{t("profileDetails")}</CardTitle>
              <CardDescription>{t("profileDetailsDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProfileForm
                initial={{
                  displayName: me.displayName ?? null,
                  jobTitle: me.jobTitle ?? null,
                  phone: me.phone ?? null,
                  officeLocation: me.officeLocation ?? null,
                  birthday: me.birthday ?? null,
                  birthdayVisible: me.birthdayVisible ?? false,
                  digestAnnouncements: me.digestAnnouncements ?? false,
                  digestMentions: me.digestMentions ?? false,
                  digestKudos: me.digestKudos ?? false,
                  digestFrequency: me.digestFrequency ?? "weekly",
                }}
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t("passwordSection")}</CardTitle>
            <CardDescription>
              {isLocal ? t("passwordDescLocal") : t("passwordDescMicrosoft")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLocal ? (
              <ChangePasswordForm />
            ) : (
              <p className="text-sm text-muted-foreground">{t("passwordManagedByMicrosoft")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
