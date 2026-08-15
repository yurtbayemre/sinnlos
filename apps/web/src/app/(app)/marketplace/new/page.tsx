import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { PageHeader } from "@/components/page-header";
import { ClassifiedForm } from "@/components/marketplace/classified-form";

export async function generateMetadata() {
  const t = await getTranslations("marketplace");
  return { title: t("formTitleNew") };
}

export default async function NewClassifiedPage() {
  const [t, session] = await Promise.all([getTranslations("marketplace"), auth()]);

  // UI gate only — the CMS permission matrix denies guest the create and
  // upload permissions regardless of what reaches it.
  if (session?.user?.role === "guest") redirect("/marketplace");

  return (
    <div className="space-y-8">
      <Link
        href="/marketplace"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("backToList")}
      </Link>
      <PageHeader title={t("formTitleNew")} description={t("formHint")} />
      <ClassifiedForm />
    </div>
  );
}
