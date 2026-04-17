import { AlertCircle } from "lucide-react";

/**
 * Reusable banner shown above content when a Strapi fetch failed. The
 * page still renders so the user gets the rest of the UI; this bar makes
 * it clear that what they see below may be incomplete.
 */
export function FetchErrorBanner({
  message = "The CMS is unreachable or returned an error. Content below may be incomplete — refresh once Strapi is back up.",
}: {
  message?: string;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1">
        <div className="font-medium">Some content couldn&apos;t be loaded</div>
        <p className="text-destructive/80">{message}</p>
      </div>
    </div>
  );
}
