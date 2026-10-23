import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/password-forms";
import { LOCAL_ENABLED } from "@/lib/auth-config";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("forgotTitle") };
}

// LOCAL_ENABLED is a runtime env decision (see sign-in/page.tsx).
export const dynamic = "force-dynamic";

/** v0.27: asks for a reset link of a local account (lib/password-actions.ts). */
export default async function ForgotPasswordPage() {
  if (!LOCAL_ENABLED) redirect("/sign-in");
  const t = await getTranslations("auth");
  return (
    <AuthCard title={t("forgotTitle")} description={t("forgotDesc")}>
      <ForgotPasswordForm />
      <p className="text-center text-sm">
        <Link href="/sign-in" className="text-primary hover:underline">
          {t("backToSignIn")}
        </Link>
      </p>
    </AuthCard>
  );
}
