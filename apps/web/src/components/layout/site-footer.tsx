import { getTranslations } from "next-intl/server";
import { shortRevision, siteLinks, VERSION } from "@/lib/site-config";
import { cn } from "@/lib/utils";

/**
 * The release, the source offer (AGPL §13), the third-party notices and the
 * operator's legal links (v0.26, M1/M3). Under every app page and on the
 * sign-in and register pages.
 */
export async function SiteFooter({ className }: { className?: string }) {
  const t = await getTranslations("footer");
  const links = siteLinks(process.env);
  const revision = shortRevision(process.env);
  const items: [string, string | null][] = [
    [t("source"), links.source],
    [t("licenses"), "/THIRD_PARTY_NOTICES.txt"],
    [t("privacy"), links.privacy],
    [t("imprint"), links.imprint],
    [t("whistleblowing"), links.whistleblowing],
  ];
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <span>
        sinnlos {VERSION}
        {revision && ` (${revision})`}
      </span>
      {items.map(([label, href]) =>
        href ? (
          <a key={label} href={href} className="hover:text-foreground hover:underline">
            {label}
          </a>
        ) : null,
      )}
    </footer>
  );
}
