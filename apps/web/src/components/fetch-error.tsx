import { AlertCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";

/**
 * Reusable banner shown above content when a Strapi fetch failed. The
 * page still renders so the user gets the rest of the UI; this bar makes
 * it clear that what they see below may be incomplete.
 */
export async function FetchErrorBanner({
  message,
}: {
  message?: string;
}) {
  const tErrors = await getTranslations("errors");

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">{tErrors("contentLoadFailed")}</div>
        <p className="text-destructive/80">{message ?? tErrors("cmsUnreachable")}</p>
      </div>
    </div>
  );
}
