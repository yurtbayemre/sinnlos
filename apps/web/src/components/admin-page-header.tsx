import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

/**
 * The header of a /manage report page (UI08: analytics, acknowledgements,
 * training): a link back to /manage, the page's h1 and its description.
 */
export async function AdminPageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  const tAdmin = await getTranslations("admin");
  return (
    <header>
      <Link
        href="/manage"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {tAdmin("title")}
      </Link>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 max-w-2xl text-muted-foreground">{description}</p> : null}
    </header>
  );
}
