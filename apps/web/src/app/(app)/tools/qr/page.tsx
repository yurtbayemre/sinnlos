import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { QrTool } from "@/components/tools/qr-tool";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("tools.qr");
  return { title: t("title") };
}

/**
 * The QR code page (v1.1 "Tools"): the page itself is a client component that works in the
 * browser only (components/tools/qr-tool.tsx). It reads the same capability as the hub, so
 * guests get the explanation instead.
 */
export default async function QrToolPage() {
  const t = await getTranslations("tools.qr");
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "processes")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      <QrTool />
    </div>
  );
}
