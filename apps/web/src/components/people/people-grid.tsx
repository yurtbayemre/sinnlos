"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/lib/utils";
import { mediaUrl } from "@/lib/config";
import type { UserLite } from "@/lib/types";

export function PeopleGrid({ people }: { people: UserLite[] }) {
  const tPeople = useTranslations("people");
  const tCommon = useTranslations("common");
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState<string>("all");

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
      if (dept !== "all" && (p.department?.slug ?? p.department?.name) !== dept)
        return false;
      if (!q) return true;
      const hay = [p.displayName, p.email, p.jobTitle, p.department?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [people, search, dept]);

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
            placeholder={tPeople("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
          />
        </div>
        {departments.length > 1 && (
          <select
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            className="h-10 rounded-xl border bg-muted/40 px-3 text-sm outline-none transition-colors focus:bg-background focus:ring-2 focus:ring-ring"
          >
            <option value="all">{tPeople("allDepartments")}</option>
            {departments.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        {tCommon("person", { count: filtered.length })}
      </p>

      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((p) => {
          const name = p.displayName ?? p.username ?? p.email ?? "Unknown";
          const avatarUrl = mediaUrl(p.avatar?.url);
          return (
            <Link
              key={p.id}
              href={`/people/${p.id}`}
              className="focus-card group block"
            >
              <Card className="card-lift h-full">
                <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
                  <Avatar className="h-16 w-16">
                    {avatarUrl ? (
                      <AvatarImage src={avatarUrl} alt={name} />
                    ) : null}
                    <AvatarFallback className="text-lg">
                      {initials(name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate font-medium transition-colors group-hover:text-primary">
                      {name}
                    </div>
                    {p.jobTitle && (
                      <div className="truncate text-sm text-muted-foreground">
                        {p.jobTitle}
                      </div>
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
    </div>
  );
}
