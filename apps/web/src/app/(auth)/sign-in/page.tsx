import Link from "next/link";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/layout/brand-mark";
import { SiteFooter } from "@/components/layout/site-footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalSignInForm } from "@/components/auth/local-sign-in-form";
import { LOCAL_ENABLED, MICROSOFT_ENABLED, OIDC } from "@/lib/auth-config";
import { signInWithMicrosoft, signInWithOidc } from "@/lib/auth-actions";
import { signInErrorKey } from "@/lib/entra-exchange";
import { brand, DEFAULT_SITE_NAME } from "@/lib/site-config";
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
  searchParams: Promise<{
    from?: string;
    expired?: string;
    passwordSet?: string;
    error?: string | string[];
  }>;
}) {
  const { from: rawFrom, expired, passwordSet, error } = await searchParams;
  const from = safeInternalPath(rawFrom);
  const errorKey = signInErrorKey(error);

  // Already signed in? Skip the form — except when we were sent here
  // because the Strapi JWT expired (?expired=1): the Auth.js cookie may
  // still exist then, and redirecting away would loop right back here.
  const session = await getSession();
  if (session && !expired) {
    // safeInternalPath guarantees an internal path — cast for typedRoutes.
    redirect(from as Route);
  }
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");
  const { name, logoUrl } = brand(process.env);
  const siteName = name ?? DEFAULT_SITE_NAME;
  const description = MICROSOFT_ENABLED
    ? LOCAL_ENABLED
      ? t("signInDescBoth")
      : t("signInDescMicrosoft")
    : OIDC
      ? LOCAL_ENABLED
        ? t("signInDescSsoBoth")
        : t("signInDescSso")
      : t("signInDescLocal");

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-linear-to-br from-background via-background to-primary/5 p-6">
      {/* Decorative background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      {/* The card is the page's main landmark; the footer stays outside it (S6). */}
      <Card role="main" className="w-full max-w-md animate-fade-in-up shadow-lg">
        <CardHeader className="text-center">
          <BrandMark
            name={siteName}
            logoUrl={logoUrl}
            className="mx-auto mb-3 h-12 w-12 rounded-2xl text-xl"
          />
          <CardTitle as="h1" className="text-2xl">
            {t("welcome", { name: siteName })}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {expired && (
            <p role="status" className="text-center text-sm text-destructive">
              {t("sessionExpired")}
            </p>
          )}
          {passwordSet && (
            <p role="status" className="text-center text-sm text-muted-foreground">
              {t("passwordSet")}
            </p>
          )}
          {errorKey && (
            <p role="alert" className="text-center text-sm text-destructive">
              {t(errorKey)}
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

          {OIDC && (
            <form action={signInWithOidc}>
              <input type="hidden" name="from" value={from} />
              <Button
                type="submit"
                size="lg"
                className="w-full transition-transform active:scale-[0.99]"
              >
                {OIDC.displayName}
              </Button>
            </form>
          )}

          {(MICROSOFT_ENABLED || OIDC) && LOCAL_ENABLED && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              {tCommon("or")}
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {LOCAL_ENABLED && <LocalSignInForm from={from} />}

          {LOCAL_ENABLED && (
            <p className="text-center text-sm">
              <Link href="/forgot-password" className="text-primary hover:underline">
                {t("forgotPassword")}
              </Link>
            </p>
          )}

          <p className="text-center text-xs text-muted-foreground">{t("itPolicy")}</p>
        </CardContent>
      </Card>
      <SiteFooter className="relative mt-6" />
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
