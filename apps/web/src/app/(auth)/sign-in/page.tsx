import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalSignInForm } from "@/components/auth/local-sign-in-form";
import { LOCAL_ENABLED, MICROSOFT_ENABLED, REGISTRATION_ENABLED } from "@/lib/auth-config";
import { signInWithMicrosoft } from "@/lib/auth-actions";
import { safeInternalPath } from "@/lib/utils";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("signIn") };
}

// Provider visibility depends on runtime env vars. Without this the
// page is prerendered inside the Docker builder stage — where no auth
// env exists — and ships with the wrong sign-in buttons baked in.
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; expired?: string }>;
}) {
  const { from: rawFrom, expired } = await searchParams;
  const from = safeInternalPath(rawFrom);

  // Already signed in? Skip the form — except when we were sent here
  // because the Strapi JWT expired (?expired=1): the Auth.js cookie may
  // still exist then, and redirecting away would loop right back here.
  const session = await auth();
  if (session && !expired) {
    redirect(from);
  }
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");
  const description = MICROSOFT_ENABLED
    ? LOCAL_ENABLED
      ? t("signInDescBoth")
      : t("signInDescMicrosoft")
    : t("signInDescLocal");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-background via-background to-primary/5 p-6">
      {/* Decorative background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <Card className="w-full max-w-md animate-fade-in-up shadow-lg">
        <CardHeader className="text-center">
          <div
            aria-hidden="true"
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground"
          >
            S
          </div>
          <CardTitle className="text-2xl">{t("welcome")}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {expired && (
            <p className="text-center text-sm text-destructive">
              {t("sessionExpired")}
            </p>
          )}
          {MICROSOFT_ENABLED && (
            <form action={signInWithMicrosoft}>
              <input type="hidden" name="from" value={from} />
              <Button
                type="submit"
                size="lg"
                className="w-full gap-2 transition-transform active:scale-[0.99]"
              >
                <MicrosoftIcon />
                {t("signInWithMicrosoft")}
              </Button>
            </form>
          )}

          {MICROSOFT_ENABLED && LOCAL_ENABLED && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              {tCommon("or")}
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {LOCAL_ENABLED && <LocalSignInForm from={from} />}

          {REGISTRATION_ENABLED && (
            <p className="text-center text-sm text-muted-foreground">
              {t("noAccount")}{" "}
              <Link href="/register" className="text-primary hover:underline">
                {t("createOne")}
              </Link>
            </p>
          )}

          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t("itPolicy")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
      <rect width="10" height="10" x="1" y="1" fill="#f25022" />
      <rect width="10" height="10" x="12" y="1" fill="#7fba00" />
      <rect width="10" height="10" x="1" y="12" fill="#00a4ef" />
      <rect width="10" height="10" x="12" y="12" fill="#ffb900" />
    </svg>
  );
}
