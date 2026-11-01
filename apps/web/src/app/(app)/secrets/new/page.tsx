import { getTranslations } from "next-intl/server";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { NewSecretForm } from "@/components/secrets/new-secret-form";

export async function generateMetadata() {
  const t = await getTranslations("secrets");
  return { title: t("new") };
}

/** /secrets/new (v0.35): send one secret to one colleague. */
export default async function NewSecretPage() {
  const [t, viewer] = await Promise.all([getTranslations("secrets"), getViewer()]);
  if (isReadDenied(viewer.role, "secrets")) {
    return <SectionUnavailablePage title={t("new")} />;
  }
  return (
    <div className="space-y-8">
      <PageHeader title={t("new")} description={t("newDescription")} />
      <NewSecretForm />
    </div>
  );
}
