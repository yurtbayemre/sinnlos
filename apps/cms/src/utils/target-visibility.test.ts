import { describe, expect, it } from "vitest";

import { isTargetVisible, visibleTargetAnchors } from "./target-visibility";

/**
 * Unit tests for the #28 target-visibility decisions. The stub answers the
 * exact `strapi.db.query` calls `loadUserScope`, `visibleWikiSpaceIds` and
 * this module make — no Strapi runtime.
 *
 * Pinned traps:
 *  - published-first: a documentId with a published AND a draft row is
 *    judged by the PUBLISHED row's targeting (a widened draft must not
 *    leak the published discussion),
 *  - wiki page without a space fails closed,
 *  - anonymous callers only see untargeted announcements / public spaces.
 */

const ENG = 1;
const DESIGN = 2;

const USERS = [
  { id: 10, role: { id: 5, type: "member" }, department: { id: ENG }, teams: [] },
  { id: 11, role: { id: 5, type: "member" }, department: { id: DESIGN }, teams: [] },
];

const ANNOUNCEMENTS = [
  // docA: untargeted, published — visible to everyone.
  { id: 1, documentId: "docA", publishedAt: "2026-01-01", audience: "all" },
  // docB: department ENG, published.
  { id: 2, documentId: "docB", publishedAt: "2026-01-01", department: { id: ENG } },
  // docC: untargeted, draft only.
  { id: 3, documentId: "docC", publishedAt: null, audience: "all" },
  // docD: published row is ENG-scoped, draft row is UNTARGETED — the
  // published row must win.
  { id: 4, documentId: "docD", publishedAt: "2026-01-01", department: { id: ENG } },
  { id: 5, documentId: "docD", publishedAt: null, audience: "all" },
];

const SPACES = [
  { id: 1, visibility: "public" },
  { id: 2, visibility: "department", department: { id: ENG } },
];

const PAGES = [
  { id: 100, documentId: "pageP", space: { id: 1 } },
  { id: 101, documentId: "pageQ", space: { id: 2 } },
  { id: 102, documentId: "pageO", space: null },
];

function stubStrapi() {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          if (uid === "plugin::users-permissions.user")
            return USERS.find((u) => u.id === where.id) ?? null;
          if (uid === "api::wiki-page.wiki-page") {
            const matches = PAGES.filter((p) => p.documentId === where.documentId);
            // publishedAt-filtered lookup first — the fixture rows carry no
            // publishedAt, so treat the filtered probe as a miss.
            if (where.publishedAt) return null;
            return matches[0] ?? null;
          }
          return null;
        },
        findMany: async ({ where }: any = {}) => {
          if (uid === "api::team.team") return [];
          if (uid === "api::announcement.announcement") {
            return where?.documentId
              ? ANNOUNCEMENTS.filter((a) => a.documentId === where.documentId)
              : ANNOUNCEMENTS;
          }
          if (uid === "api::wiki-space.wiki-space") return SPACES;
          if (uid === "api::wiki-page.wiki-page") {
            const ids: number[] = where?.space?.id?.$in ?? [];
            return PAGES.filter((p) => p.space && ids.includes(p.space.id));
          }
          return [];
        },
      }),
    },
  } as any;
}

const engMember = { id: 10, role: { type: "member" } };
const designMember = { id: 11, role: { type: "member" } };
const admin = { id: 99, role: { type: "admin_role" } };

describe("visibleTargetAnchors", () => {
  it("gives an ENG member everything ENG-scoped plus untargeted", async () => {
    const anchors = await visibleTargetAnchors(stubStrapi(), engMember);
    expect(anchors.announcement.sort()).toEqual(["docA", "docB", "docC", "docD"]);
    expect(anchors["wiki-page"].sort()).toEqual(["pageP", "pageQ"]);
  });

  it("judges a mixed draft/published documentId by its PUBLISHED row", async () => {
    const anchors = await visibleTargetAnchors(stubStrapi(), designMember);
    // docD's draft is untargeted, but the published row is ENG-only.
    expect(anchors.announcement.sort()).toEqual(["docA", "docC"]);
    expect(anchors["wiki-page"]).toEqual(["pageP"]);
  });

  it("restricts anonymous callers to untargeted / public targets", async () => {
    const anchors = await visibleTargetAnchors(stubStrapi(), null);
    expect(anchors.announcement.sort()).toEqual(["docA", "docC"]);
    expect(anchors["wiki-page"]).toEqual(["pageP"]);
  });
});

describe("isTargetVisible", () => {
  it("bypasses for admin_role without resolving anything", async () => {
    const bomb = {
      db: {
        query: () => ({
          findOne: () => {
            throw new Error("no query expected");
          },
          findMany: () => {
            throw new Error("no query expected");
          },
        }),
      },
    } as any;
    await expect(isTargetVisible(bomb, "announcement", "docB", admin)).resolves.toBe(true);
  });

  it("hides a department-scoped announcement from the wrong department", async () => {
    await expect(isTargetVisible(stubStrapi(), "announcement", "docB", designMember)).resolves.toBe(
      false,
    );
    await expect(isTargetVisible(stubStrapi(), "announcement", "docB", engMember)).resolves.toBe(
      true,
    );
  });

  it("prefers the published row over a widened draft", async () => {
    await expect(isTargetVisible(stubStrapi(), "announcement", "docD", designMember)).resolves.toBe(
      false,
    );
  });

  it("fails closed for a wiki page without a space", async () => {
    await expect(isTargetVisible(stubStrapi(), "wiki-page", "pageO", engMember)).resolves.toBe(
      false,
    );
  });

  it("scopes wiki pages by their space", async () => {
    await expect(isTargetVisible(stubStrapi(), "wiki-page", "pageQ", designMember)).resolves.toBe(
      false,
    );
    await expect(isTargetVisible(stubStrapi(), "wiki-page", "pageQ", engMember)).resolves.toBe(
      true,
    );
    await expect(isTargetVisible(stubStrapi(), "wiki-page", "pageP", designMember)).resolves.toBe(
      true,
    );
  });

  it("fails closed for an unknown documentId", async () => {
    await expect(isTargetVisible(stubStrapi(), "announcement", "ghost", engMember)).resolves.toBe(
      false,
    );
    await expect(isTargetVisible(stubStrapi(), "wiki-page", "ghost", engMember)).resolves.toBe(
      false,
    );
  });
});
