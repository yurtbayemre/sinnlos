"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { SelectMenu } from "@/components/ui/select-menu";
import { initials } from "@/lib/utils";
import { PEOPLE_PAGE_SIZE, visibleCount, type PersonCard } from "@/lib/people-dto";

/**
 * The /people grid over the lean card DTO (lib/people-dto.ts, WD05). It
 * renders PEOPLE_PAGE_SIZE cards per step instead of mounting the whole
 * directory at once; the count line counts every match, and search and
 * the department filter run over the whole list (a change starts again at
 * the first step).
 */
export function PeopleGrid({ people }: { people: PersonCard[] }) {
  const tPeople = useTranslations("people");
  const tCommon = useTranslations("common");
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState<string>("all");
  const [pages, setPages] = useState(1);

  const departments = useMemo(() => {
    const set = new Map<string, string>();
    for (const p of people) {
      if (p.department?.name) {
        set.set(p.department.slug ?? p.department.name, p.department.name);
      }
    }
    return Array.from(set.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [people]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return people.filter((p) => {
      if (dept !== "all" && (p.department?.slug ?? p.department?.name) !== dept) return false;
      if (!q) return true;
      const hay = [p.name, p.email, p.jobTitle, p.department?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [people, search, dept]);

  const shown = visibleCount(filtered.length, pages);
  const next = Math.min(PEOPLE_PAGE_SIZE, filtered.length - shown);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            aria-label={tPeople("searchPlaceholder")}
            placeholder={tPeople("searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPages(1);
            }}
            className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
          />
        </div>
        {departments.length > 1 && (
          <SelectMenu
            value={dept}
            onChange={(value) => {
              setDept(value);
              setPages(1);
            }}
            ariaLabel={tPeople("filterByDepartment")}
            align="right"
            buttonClassName="w-full sm:w-52"
            options={[
              { value: "all", label: tPeople("allDepartments") },
              ...departments.map(([slug, name]) => ({ value: slug, label: name })),
            ]}
          />
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        {tCommon("person", { count: filtered.length })}
      </p>

      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.slice(0, shown).map((p) => {
          const name = p.name ?? tCommon("unknown");
          return (
            <Link key={p.id} href={`/people/${p.id}`} className="focus-card group block">
              <Card className="card-lift h-full">
                <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
                  <Avatar className="h-16 w-16">
                    {p.avatarUrl ? (
                      <AvatarImage src={p.avatarUrl} alt={name} loading="lazy" />
                    ) : null}
                    <AvatarFallback className="text-lg">{initials(name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium transition-colors group-hover:text-primary">
                      {name}
                    </div>
                    {p.jobTitle && (
                      <div className="truncate text-sm text-muted-foreground">{p.jobTitle}</div>
                    )}
                    {p.department?.name && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {p.department.name}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {next > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setPages((current) => current + 1)}
            className="rounded-xl border px-4 py-2 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            + {tCommon("person", { count: next })}
          </button>
        </div>
      )}
    </div>
  );
}
