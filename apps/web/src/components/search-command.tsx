"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Command } from "cmdk";
import {
  Search,
  BarChart3,
  Building2,
  Calendar,
  Contact,
  Users,
  BookOpen,
  FileText,
  Megaphone,
} from "lucide-react";
import { fetchSearchItems, logSearch, searchContent, type SearchItem } from "@/lib/search-action";
import { useTranslations } from "next-intl";

export function SearchCommand() {
  const tSearch = useTranslations("search");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [preloaded, setPreloaded] = useState<SearchItem[]>([]);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [isPending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(false);

  // --- Search instrumentation (issue #19, stage 1) -----------------------
  // Only SETTLED queries are logged: the newest (query, resultCount) pair
  // becomes pending whenever results arrive, and is flushed after 2s of
  // stability, on selection, or when the palette closes. Logging inside
  // the 300ms debounce directly would record every typed prefix and bury
  // the zero-result signal the Meilisearch decision depends on.
  const pendingLogRef = useRef<{ term: string; count: number } | null>(null);
  const lastLoggedTermRef = useRef("");
  const logTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSearchLog = useCallback(() => {
    if (logTimerRef.current) {
      clearTimeout(logTimerRef.current);
      logTimerRef.current = null;
    }
    const pending = pendingLogRef.current;
    pendingLogRef.current = null;
    if (!pending || pending.term === lastLoggedTermRef.current) return;
    lastLoggedTermRef.current = pending.term;
    void logSearch(pending.term, pending.count);
  }, []);

  const scheduleSearchLog = useCallback(
    (term: string, count: number) => {
      pendingLogRef.current = { term, count };
      if (logTimerRef.current) clearTimeout(logTimerRef.current);
      logTimerRef.current = setTimeout(flushSearchLog, 2000);
    },
    [flushSearchLog],
  );

  useEffect(() => {
    if (!open) flushSearchLog();
  }, [open, flushSearchLog]);

  useEffect(() => () => flushSearchLog(), [flushSearchLog]);

  // Load items when the dialog first opens. Post-await updates need their
  // own startTransition — after an await the outer transition scope is
  // gone and the setState would otherwise render as urgent (issue #36).
  useEffect(() => {
    if (open && !loaded) {
      startTransition(async () => {
        const data = await fetchSearchItems();
        startTransition(() => {
          setPreloaded(data);
          setLoaded(true);
        });
      });
    }
  }, [open, loaded]);

  // Debounced server-side search. Below two characters nothing is
  // fetched and the display derives from `preloaded` — no state clearing
  // in the effect (issue #36); stale results linger invisibly and are
  // replaced by the next settled fetch.
  useEffect(() => {
    if (query.length < 2) return;
    const timeout = setTimeout(() => {
      startTransition(async () => {
        const results = await searchContent(query);
        startTransition(() => setSearchResults(results));
        scheduleSearchLog(query, results.length);
      });
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, scheduleSearchLog]);

  const items = query.length >= 2 ? searchResults : preloaded;

  // Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const select = useCallback(
    (href: Route) => {
      // A selection is the strongest "this query settled" signal.
      flushSearchLog();
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router, flushSearchLog],
  );

  const icon = (kind: SearchItem["kind"]) => {
    switch (kind) {
      case "department":
        return <Building2 className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "team":
        return <Users className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "wiki-space":
        return <BookOpen className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "wiki-page":
        return <FileText className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "announcement":
        return <Megaphone className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "person":
        return <Contact className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "event":
        return <Calendar className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "poll":
        return <BarChart3 className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
      case "document":
        return <FileText className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    }
  };

  const grouped: Record<string, SearchItem[]> = {};
  for (const item of items) {
    const g = grouped[item.kind] ?? (grouped[item.kind] = []);
    g.push(item);
  }

  const groupLabel: Record<string, string> = {
    department: tNav("departments"),
    team: tNav("teams"),
    "wiki-space": tNav("wiki"),
    "wiki-page": tNav("wiki"),
    announcement: tNav("announcements"),
    person: tNav("people"),
    event: tNav("events"),
    poll: tNav("polls"),
    document: tNav("documents"),
  };

  return (
    <>
      {/* Trigger — icon-only on phones, full search-input look from sm up */}
      <button
        type="button"
        aria-label={tSearch("label")}
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:w-full sm:max-w-xl sm:justify-start sm:pl-9 sm:pr-3"
      >
        <Search
          aria-hidden="true"
          className="h-4 w-4 sm:pointer-events-none sm:absolute sm:left-3 sm:top-1/2 sm:-translate-y-1/2"
        />
        <span className="hidden truncate sm:inline">{tSearch("placeholder")}</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>

      {/* Command palette as a real modal (issue #31): Command.Dialog wraps
          Radix Dialog, which supplies the focus trap, Tab cycling, Escape,
          outside-click close and focus restore to the trigger — the
          previous hand-rolled portal announced aria-modal without making
          the background inert. Radix portals to <body>, which the repo
          requires anyway: the sticky topbar's backdrop-blur turns the
          header into the containing block for fixed descendants. */}
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label={tSearch("globalSearch")}
        shouldFilter={query.length < 2}
        overlayClassName="fixed inset-0 z-50 animate-fade-in bg-background/60 backdrop-blur-sm"
        contentClassName="fixed inset-x-3 top-[4.5rem] z-50 mx-auto max-w-lg animate-scale-in"
        className="overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder={tSearch("searchPlaceholder")}
            className="flex h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          {isPending && (
            <Command.Loading>
              <div className="py-6 text-center text-sm text-muted-foreground">
                {tCommon("loading")}
              </div>
            </Command.Loading>
          )}
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
            {tCommon("noResults")}
          </Command.Empty>
          {Object.entries(grouped).map(([kind, groupItems]) => (
            <Command.Group
              key={kind}
              heading={groupLabel[kind] ?? kind}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {groupItems.map((item) => (
                <Command.Item
                  key={`${item.kind}-${item.href}`}
                  value={`${item.title} ${item.subtitle ?? ""}`}
                  onSelect={() => select(item.href)}
                  className="flex cursor-pointer items-center rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  {icon(item.kind)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{item.title}</div>
                    {item.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </div>
                    )}
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command.Dialog>
    </>
  );
}
