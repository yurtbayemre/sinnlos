"use server";

import { api, strapi, type StrapiListResponse } from "@/lib/strapi";

export type SearchItem = {
  kind: "department" | "team" | "wiki-space" | "wiki-page" | "announcement" | "person" | "event" | "poll" | "document";
  title: string;
  subtitle?: string;
  href: string;
};

export async function fetchSearchItems(): Promise<SearchItem[]> {
  const [departments, teams, wikiSpaces, wikiPages, announcements, events, polls, documents] = await Promise.all([
    api.departments.list().catch(() => ({ data: [] })),
    api.teams.list().catch(() => ({ data: [] })),
    api.wiki.spaces().catch(() => ({ data: [] })),
    // Bypasses the Next.js fetch cache: wiki-pages are filtered by the
    // wiki-visibility policy so cached responses would leak restricted
    // pages across users.
    strapi<StrapiListResponse<any>>(
      "/api/wiki-pages?populate[space]=true&populate[author]=true&pagination[pageSize]=100&sort=title:asc",
      { noCache: true },
    ).catch(() => ({ data: [] })),
    api.announcements.list().catch(() => ({ data: [] })),
    api.events.list().catch(() => ({ data: [] })),
    api.polls.list().catch(() => ({ data: [] })),
    api.documents.list().catch(() => ({ data: [] })),
  ]);

  const items: SearchItem[] = [];

  for (const d of departments.data) {
    items.push({
      kind: "department",
      title: d.name,
      subtitle: d.description,
      href: `/departments/${d.slug}`,
    });
  }

  for (const t of teams.data) {
    items.push({
      kind: "team",
      title: t.name,
      subtitle: t.department?.name
        ? `${t.department.name} · ${t.description ?? ""}`
        : t.description,
      href: `/teams/${t.slug}`,
    });
  }

  for (const s of wikiSpaces.data) {
    items.push({
      kind: "wiki-space",
      title: s.name,
      subtitle: s.description,
      href: `/wiki/${s.slug}`,
    });
  }

  for (const p of wikiPages.data) {
    const spaceSlug = p.space?.slug;
    if (!spaceSlug) continue;
    items.push({
      kind: "wiki-page",
      title: p.title,
      subtitle: `${p.space.name ?? spaceSlug} · ${p.summary ?? ""}`,
      href: `/wiki/${spaceSlug}/${p.slug}`,
    });
  }

  for (const a of announcements.data) {
    items.push({
      kind: "announcement",
      title: a.title,
      subtitle: a.author?.displayName,
      href: "/announcements",
    });
  }

  for (const e of events.data) {
    items.push({
      kind: "event",
      title: e.title,
      subtitle: e.start ? new Date(e.start).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : undefined,
      href: "/events",
    });
  }

  for (const p of polls.data) {
    items.push({
      kind: "poll",
      title: p.question,
      subtitle: p.closesAt ? `Closes ${new Date(p.closesAt).toLocaleDateString()}` : "Open",
      href: "/polls",
    });
  }

  for (const d of documents.data) {
    items.push({
      kind: "document",
      title: d.title,
      subtitle: d.description ?? d.category ?? undefined,
      href: "/documents",
    });
  }

  const people = await strapi<any[]>(
    "/api/users?populate[department]=true&pagination[pageSize]=200&sort=displayName:asc",
    { noCache: true },
  ).catch(() => []);

  for (const u of people) {
    items.push({
      kind: "person",
      title: u.displayName ?? u.username ?? u.email ?? "Unknown",
      subtitle: [u.jobTitle, u.department?.name].filter(Boolean).join(" · "),
      href: `/people/${u.id}`,
    });
  }

  return items;
}
