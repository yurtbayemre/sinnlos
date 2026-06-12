import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalSignInForm } from "@/components/auth/local-sign-in-form";
import { LOCAL_ENABLED, MICROSOFT_ENABLED, REGISTRATION_ENABLED } from "@/lib/auth-config";
import { signInWithMicrosoft } from "@/lib/auth-actions";

export const metadata = { title: "Sign in" };

// Provider visibility depends on runtime env vars. Without this the
// page is prerendered inside the Docker builder stage — where no auth
// env exists — and ships with the wrong sign-in buttons baked in.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  const description = MICROSOFT_ENABLED
    ? LOCAL_ENABLED
      ? "Sign in with your Microsoft account or your email and password"
      : "Sign in with your company Microsoft account to continue"
    : "Sign in with your email and password to continue";

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
          <CardTitle className="text-2xl">Welcome to Sinnlos</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {MICROSOFT_ENABLED && (
            <form action={signInWithMicrosoft}>
              <Button
                type="submit"
                size="lg"
                className="w-full gap-2 transition-transform active:scale-[0.99]"
              >
                <MicrosoftIcon />
                Sign in with Microsoft
              </Button>
            </form>
          )}

          {MICROSOFT_ENABLED && LOCAL_ENABLED && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              or
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {LOCAL_ENABLED && <LocalSignInForm />}

          {REGISTRATION_ENABLED && (
            <p className="text-center text-sm text-muted-foreground">
              No account?{" "}
              <Link href="/register" className="text-primary hover:underline">
                Create one
              </Link>
            </p>
          )}

          <p className="mt-2 text-center text-xs text-muted-foreground">
            By signing in you agree to the company IT policy.
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
