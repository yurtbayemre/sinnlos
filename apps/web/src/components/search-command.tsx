"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { fetchSearchItems, type SearchItem } from "@/lib/search-action";

export function SearchCommand() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [isPending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(false);

  // Load items when the dialog first opens
  useEffect(() => {
    if (open && !loaded) {
      startTransition(async () => {
        const data = await fetchSearchItems();
        setItems(data);
        setLoaded(true);
      });
    }
  }, [open, loaded]);

  // Ctrl+K / Cmd+K shortcut + Escape to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const select = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router],
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
    department: "Departments",
    team: "Teams",
    "wiki-space": "Wiki Spaces",
    "wiki-page": "Wiki Pages",
    announcement: "Announcements",
    person: "People",
    event: "Events",
    poll: "Polls",
    document: "Documents",
  };

  return (
    <>
      {/* Trigger — looks like the old search input */}
      <button
        type="button"
        aria-label="Search (Ctrl+K)"
        onClick={() => setOpen(true)}
        className="relative flex h-10 w-full max-w-xl items-center rounded-xl border bg-muted/40 pl-9 pr-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
        />
        <span>Search wiki, people, teams…</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>

      {/* Command palette overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-background/60 pt-[4.5rem] backdrop-blur-sm"
          onMouseDown={() => setOpen(false)}
        >
          <Command
            label="Global search"
            className="relative w-full max-w-lg animate-scale-in overflow-hidden rounded-xl border bg-background shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
            shouldFilter={true}
          >
            <div className="flex items-center border-b px-3">
              <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search…"
                className="flex h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              {isPending && (
                <Command.Loading>
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    Loading…
                  </div>
                </Command.Loading>
              )}
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No results found.
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
          </Command>
        </div>
      )}
    </>
  );
}
