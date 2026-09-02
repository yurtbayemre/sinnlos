import Link from "next/link";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";
import { ExternalLink, Link2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ICONS, isIconName } from "@/components/icon-map";

/**
 * Dashboard widget: the central link gateway (payroll portal, ticket
 * system, HR tools, ...). Server component — quick links are fetched by
 * the dashboard page (department-scoped by the CMS policy, so strictly
 * uncached) and passed down as plain data. Icons arrive as CMS-managed
 * strings and are resolved through the shared icon map.
 */
type QuickLink = {
  id: number;
  label?: string;
  url?: string;
  icon?: string | null;
  category?: string | null;
  order?: number;
};

const CATEGORY_ORDER = ["hr", "it", "tools", "extern"] as const;
type Category = (typeof CATEGORY_ORDER)[number];

function categoryOf(link: QuickLink): Category {
  const c = link.category ?? "";
  return (CATEGORY_ORDER as readonly string[]).includes(c) ? (c as Category) : "tools";
}

export async function QuickLinks({ items }: { items: QuickLink[] }) {
  const valid = items.filter((l) => l.label && l.url);
  // Empty state: hide the widget entirely.
  if (valid.length === 0) return null;

  const t = await getTranslations("quickLinks");

  // Items arrive sorted by `order` (then label) from the API; grouping
  // with filter() preserves that order within each category.
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    links: valid.filter((l) => categoryOf(l) === category),
  })).filter((g) => g.links.length > 0);

  return (
    <section className="space-y-4">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("eyebrow")}
        </div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{t("title")}</h2>
      </div>

      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.category} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t(`categories.${group.category}`)}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {group.links.map((link) => (
                <QuickLinkCard key={link.id} link={link} newTabLabel={t("openInNewTab")} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuickLinkCard({ link, newTabLabel }: { link: QuickLink; newTabLabel: string }) {
  const Icon = isIconName(link.icon) ? ICONS[link.icon] : Link2;
  // Relative URLs stay in-app; everything else is an external portal.
  const external = !link.url!.startsWith("/");

  const card = (
    <Card className="card-lift h-full cursor-pointer">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-110">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{link.label}</div>
        {external && (
          <>
            <ExternalLink
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">{newTabLabel}</span>
          </>
        )}
      </CardContent>
    </Card>
  );

  return external ? (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className="focus-card group block">
      {card}
    </a>
  ) : (
    // CMS-provided path: typedRoutes cannot verify data-driven strings —
    // `external` above already ensured this is an internal path.
    <Link href={link.url! as Route} className="focus-card group block">
      {card}
    </Link>
  );
}
