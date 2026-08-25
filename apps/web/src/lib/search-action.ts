"use server";

import { unstable_rethrow } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { api, strapi, type StrapiListResponse } from "@/lib/strapi";

// Fallbacks for the best-effort fetches below. They rethrow Next.js
// control-flow errors (e.g. the redirect strapi() issues on 401) so an
// expired session navigates to sign-in instead of showing empty results.
function emptyList(e: unknown): { data: any[] } {
  unstable_rethrow(e);
  return { data: [] };
}
function emptyArray(e: unknown): any[] {
  unstable_rethrow(e);
  return [];
}

export type SearchItem = {
  kind:
    | "department"
    | "team"
    | "wiki-space"
    | "wiki-page"
    | "announcement"
    | "person"
    | "event"
    | "poll"
    | "document";
  title: string;
  subtitle?: string;
  href: string;
};

export async function fetchSearchItems(): Promise<SearchItem[]> {
  const [locale, tSearch, tCommon] = await Promise.all([
    getLocale(),
    getTranslations("search"),
    getTranslations("common"),
  ]);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Preload coverage (issue #26): departments/teams/wiki-spaces are full
  // page walks since #26, so those indexes are complete. Deliberately
  // capped remain the wiki-pages preload (pageSize=100), announcements
  // (20), events.upcoming (50), polls (20), documents (50) and the users
  // preload below (users-permissions ignores pagination[] params anyway,
  // see the analytics countUsers note). That is fine: this preload is a
  // best-effort typeahead — the live search in searchContent() queries
  // Strapi with $containsi and finds everything beyond these windows.
  const [departments, teams, wikiSpaces, wikiPages, announcements, events, polls, documents] =
    await Promise.all([
      api.departments.list().catch(emptyList),
      api.teams.list().catch(emptyList),
      api.wiki.spaces().catch(emptyList),
      // Bypasses the Next.js fetch cache: wiki-pages are filtered by the
      // wiki-visibility policy so cached responses would leak restricted
      // pages across users.
      strapi<StrapiListResponse<any>>(
        "/api/wiki-pages?populate[space]=true&populate[author]=true&pagination[pageSize]=100&sort=title:asc",
        { noCache: true },
      ).catch(emptyList),
      api.announcements.list().catch(emptyList),
      // Upcoming only (api.events is time-window based now): the old global
      // list returned the 50 oldest events, so current ones were unfindable
      // anyway once history grew past 50.
      api.events.upcoming(startOfToday.toISOString()).catch(emptyList),
      api.polls.list().catch(emptyList),
      api.documents.list().catch(emptyList),
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
      subtitle: e.start
        ? new Date(e.start).toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : undefined,
      href: "/events",
    });
  }

  for (const p of polls.data) {
    items.push({
      kind: "poll",
      title: p.question,
      subtitle: p.closesAt
        ? tSearch("pollCloses", { date: new Date(p.closesAt).toLocaleDateString(locale) })
        : tSearch("pollOpen"),
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
  ).catch(emptyArray);

  // DEMO_MODE answers /api/users with a `{ data, meta }` object, not an
  // array — same guard as in searchContent below.
  const peoplePreload = Array.isArray(people) ? people : [];
  for (const u of peoplePreload) {
    items.push({
      kind: "person",
      title: u.displayName ?? u.username ?? u.email ?? tCommon("unknown"),
      subtitle: [u.jobTitle, u.department?.name].filter(Boolean).join(" · "),
      href: `/people/${u.id}`,
    });
  }

  return items;
}

export async function searchContent(query: string): Promise<SearchItem[]> {
  if (!query || query.length < 2) return [];

  const [locale, tSearch, tCommon] = await Promise.all([
    getLocale(),
    getTranslations("search"),
    getTranslations("common"),
  ]);
  const q = encodeURIComponent(query);
  const items: SearchItem[] = [];

  const [announcements, wikiPages, documents, events, polls, people] = await Promise.all([
    strapi<StrapiListResponse<any>>(
      `/api/announcements?filters[$or][0][title][$containsi]=${q}&filters[$or][1][body][$containsi]=${q}&populate[author]=true&pagination[pageSize]=5&sort=createdAt:desc`,
      { noCache: true },
    ).catch(emptyList),
    strapi<StrapiListResponse<any>>(
      `/api/wiki-pages?filters[$or][0][title][$containsi]=${q}&filters[$or][1][body][$containsi]=${q}&populate[space]=true&pagination[pageSize]=5&sort=title:asc`,
      { noCache: true },
    ).catch(emptyList),
    strapi<StrapiListResponse<any>>(
      `/api/documents?filters[$or][0][title][$containsi]=${q}&filters[$or][1][description][$containsi]=${q}&populate[file]=true&pagination[pageSize]=5&sort=title:asc`,
      { noCache: true },
    ).catch(emptyList),
    strapi<StrapiListResponse<any>>(
      `/api/events?filters[title][$containsi]=${q}&pagination[pageSize]=5&sort=start:desc`,
      { noCache: true },
    ).catch(emptyList),
    strapi<StrapiListResponse<any>>(
      `/api/polls?filters[question][$containsi]=${q}&pagination[pageSize]=5&sort=createdAt:desc`,
      { noCache: true },
    ).catch(emptyList),
    strapi<any[]>(
      `/api/users?filters[$or][0][displayName][$containsi]=${q}&filters[$or][1][email][$containsi]=${q}&filters[$or][2][jobTitle][$containsi]=${q}&populate[department]=true&pagination[pageSize]=5&sort=displayName:asc`,
      { noCache: true },
    ).catch(emptyArray),
  ]);

  for (const a of (announcements as any).data ?? []) {
    items.push({
      kind: "announcement",
      title: a.title,
      subtitle: a.author?.displayName,
      href: "/announcements",
    });
  }

  for (const p of (wikiPages as any).data ?? []) {
    const spaceSlug = p.space?.slug;
    if (!spaceSlug) continue;
    items.push({
      kind: "wiki-page",
      title: p.title,
      subtitle: p.space?.name ?? spaceSlug,
      href: `/wiki/${spaceSlug}/${p.slug}`,
    });
  }

  for (const d of (documents as any).data ?? []) {
    items.push({
      kind: "document",
      title: d.title,
      subtitle: d.description ?? d.category ?? undefined,
      href: "/documents",
    });
  }

  for (const e of (events as any).data ?? []) {
    items.push({
      kind: "event",
      title: e.title,
      subtitle: e.start
        ? new Date(e.start).toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : undefined,
      href: "/events",
    });
  }

  for (const p of (polls as any).data ?? []) {
    items.push({
      kind: "poll",
      title: p.question,
      subtitle: p.closesAt
        ? tSearch("pollCloses", { date: new Date(p.closesAt).toLocaleDateString(locale) })
        : tSearch("pollOpen"),
      href: "/polls",
    });
  }

  const peopleArr = Array.isArray(people) ? people : [];
  for (const u of peopleArr) {
    items.push({
      kind: "person",
      title: u.displayName ?? u.username ?? u.email ?? tCommon("unknown"),
      subtitle: [u.jobTitle, u.department?.name].filter(Boolean).join(" · "),
      href: `/people/${u.id}`,
    });
  }

  return items;
}
