import { auth } from "@/auth";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { initials } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileForm } from "@/components/profile/profile-form";
import { ChangePasswordForm } from "@/components/profile/change-password-form";

export const metadata = { title: "My profile" };

export default async function ProfilePage() {
  const session = await auth();
  const isLocal = (session as any)?.provider === "local";

  const { data, failed } = await tryFetch(
    () => strapi<{ data: any }>("/api/me", { noCache: true }),
    "profile",
  );
  const me = data?.data ?? null;

  const name =
    me?.displayName ?? me?.username ?? session?.user?.name ?? "Unknown";
  const email = me?.email ?? session?.user?.email ?? "";
  const avatarUrl = me?.avatar?.url ?? session?.user?.image ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My profile"
        description="Manage how you appear to colleagues across the intranet."
      />

      {failed && <FetchErrorBanner />}

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
        <Card>
          <CardHeader>
            <CardTitle>Profile details</CardTitle>
            <CardDescription>
              Your display name and contact details, shown on the people directory.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm
              initial={{
                displayName: me?.displayName ?? null,
                jobTitle: me?.jobTitle ?? null,
                phone: me?.phone ?? null,
                officeLocation: me?.officeLocation ?? null,
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>
              {isLocal
                ? "Change the password you use to sign in."
                : "Account security settings."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLocal ? (
              <ChangePasswordForm />
            ) : (
              <p className="text-sm text-muted-foreground">
                Your password is managed by your Microsoft account.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
