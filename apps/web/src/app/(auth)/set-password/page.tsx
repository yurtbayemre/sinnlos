import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { SetPasswordForm } from "@/components/auth/password-forms";
import { LOCAL_ENABLED } from "@/lib/auth-config";

export async function generateMetadata() {
  const t = await getTranslations("auth");
  return { title: t("setPasswordTitle"), referrer: "no-referrer" };
}

// LOCAL_ENABLED is a runtime env decision (see sign-in/page.tsx).
export const dynamic = "force-dynamic";

/** v0.27: the target of an invitation or reset mail (token in the URL fragment). */
export default async function SetPasswordPage() {
  if (!LOCAL_ENABLED) redirect("/sign-in");
  const t = await getTranslations("auth");
  return (
    <AuthCard title={t("setPasswordTitle")} description={t("setPasswordDesc")}>
      <SetPasswordForm />
    </AuthCard>
  );
}
