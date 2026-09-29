"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Ellipsis, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ICONS } from "@/components/icon-map";
import { isNavActive, type NavItem } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

const TAB_CLASS = cn(
  "flex min-w-0 flex-1 flex-col items-center gap-1 py-2 text-[11px] outline-none transition-colors",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
);

/**
 * Bottom tab bar shown on small screens, where the sidebar is hidden (FX30).
 * It maps the same entries as the sidebar (lib/nav-config.ts), which the
 * server picked for the viewer's role: the `mobilePrimary` ones as tabs, all
 * others (training, departments, teams, kudos, marketplace, polls,
 * documents and /manage for admins) in a More sheet, so every section is
 * reachable on a phone. The sheet is a Radix dialog: focus moves into it
 * and back to the More tab, Escape and the backdrop close it, and so does
 * choosing an entry.
 */
export function MobileNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);

  const primary = items.filter((item) => item.mobilePrimary);
  const more = items.filter((item) => !item.mobilePrimary);
  const moreActive = more.some((item) => isNavActive(pathname, item.href));

  return (
    <nav
      aria-label={tCommon("bottomNav")}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex">
        {primary.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isNavActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(TAB_CLASS, active ? "text-primary" : "text-muted-foreground")}
            >
              <Icon
                aria-hidden="true"
                className={cn("h-5 w-5 transition-transform duration-150", active && "scale-110")}
              />
              <span className="max-w-full truncate px-0.5">
                {t(item.mobileLabelKey ?? item.labelKey)}
              </span>
            </Link>
          );
        })}

        {more.length > 0 && (
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger
              className={cn(TAB_CLASS, moreActive ? "text-primary" : "text-muted-foreground")}
              data-active={moreActive ? "true" : undefined}
            >
              <Ellipsis
                aria-hidden="true"
                className={cn(
                  "h-5 w-5 transition-transform duration-150",
                  moreActive && "scale-110",
                )}
              />
              <span className="max-w-full truncate px-0.5">{t("more")}</span>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-background/60 backdrop-blur-sm md:hidden" />
              <Dialog.Content
                // No description: the title and the entries say it all
                // (Radix warns unless aria-describedby is set explicitly).
                aria-describedby={undefined}
                className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t bg-background p-4 shadow-2xl outline-none animate-in slide-in-from-bottom duration-200 motion-reduce:animate-none md:hidden"
                style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
              >
                <div className="mb-3 flex items-center justify-between">
                  <Dialog.Title className="text-base font-semibold">
                    {t("moreSections")}
                  </Dialog.Title>
                  <Dialog.Close
                    aria-label={tCommon("close")}
                    className="rounded-lg p-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Dialog.Close>
                </div>
                <MoreSheetLinks
                  items={more}
                  pathname={pathname}
                  onNavigate={() => setOpen(false)}
                />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
    </nav>
  );
}

/**
 * The entries of the More sheet: a grid of links, the current section
 * marked. Choosing one closes the sheet (onNavigate) while the route loads.
 */
export function MoreSheetLinks({
  items,
  pathname,
  onNavigate,
}: {
  items: readonly NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  const t = useTranslations("nav");
  return (
    <ul className="grid grid-cols-3 gap-2">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isNavActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "flex h-full flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center text-xs outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon aria-hidden="true" className="h-5 w-5" />
              <span className="max-w-full break-words">{t(item.labelKey)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
