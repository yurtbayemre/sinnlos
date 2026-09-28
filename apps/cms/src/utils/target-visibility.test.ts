import { describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import {
  isTargetVisible,
  pinnedTargetAnchor,
  visibleTargetAnchors,
  type CallerUser,
} from "./target-visibility";

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

/**
 * PL04: the list (visibleTargetAnchors) and the single-anchor check
 * (isTargetVisible) judge a wiki page by the same row, its published row
 * when it has one. A page's draft and published rows link the draft and
 * published rows of their spaces, and those can differ until a publish: a
 * space widened in a draft, a page moved into another space in a draft.
 */
describe("wiki pages: the list and the single check agree (published row first)", () => {
  const ENG_DEPT = 10;
  const SALES_DEPT = 11;
  const PUBLISHED = "2026-09-01T00:00:00.000Z";

  const space = (id: number, documentId: string, published: boolean, data: object) => ({
    id,
    documentId,
    publishedAt: published ? PUBLISHED : null,
    ...data,
  });
  const page = (id: number, documentId: string, published: boolean, spaceId: number | null) => ({
    id,
    documentId,
    title: documentId,
    publishedAt: published ? PUBLISHED : null,
    space: spaceId === null ? null : { id: spaceId },
  });

  function stub(): StrapiStub {
    return createStrapiStub({
      tables: {
        "api::department.department": [
          { id: ENG_DEPT, documentId: "deng00000000000000000000", name: "Eng" },
          { id: SALES_DEPT, documentId: "dsal00000000000000000000", name: "Sales" },
        ],
        "plugin::users-permissions.user": [
          { id: 1, username: "eng", department: { id: ENG_DEPT }, teams: [] },
          { id: 2, username: "sales", department: { id: SALES_DEPT }, teams: [] },
        ],
        "api::wiki-space.wiki-space": [
          space(1, "space-open", true, { visibility: "public" }),
          space(2, "space-open", false, { visibility: "public" }),
          space(3, "space-eng", true, { visibility: "department", department: { id: ENG_DEPT } }),
          space(4, "space-eng", false, { visibility: "department", department: { id: ENG_DEPT } }),
          // Sales-only when published; the unpublished draft is public.
          space(5, "space-widened", true, {
            visibility: "department",
            department: { id: SALES_DEPT },
          }),
          space(6, "space-widened", false, { visibility: "public" }),
        ],
        "api::wiki-page.wiki-page": [
          page(100, "page-open", true, 1),
          page(101, "page-open", false, 2),
          page(102, "page-eng", true, 3),
          page(103, "page-eng", false, 4),
          page(104, "page-widened", true, 5),
          page(105, "page-widened", false, 6),
          // Published in Engineering, draft moved into the open space.
          page(106, "page-moved-in", true, 3),
          page(107, "page-moved-in", false, 2),
          // Published in the open space, draft moved into Engineering.
          page(108, "page-moved-out", true, 1),
          page(109, "page-moved-out", false, 4),
          page(110, "page-draft-only", false, 2),
          // The published row lost its space, the draft still has one.
          page(111, "page-no-space", true, null),
          page(112, "page-no-space", false, 2),
        ],
      },
    });
  }

  const PAGES = [
    "page-open",
    "page-eng",
    "page-widened",
    "page-moved-in",
    "page-moved-out",
    "page-draft-only",
    "page-no-space",
  ];
  const CALLERS: [string, CallerUser | null][] = [
    ["eng", { id: 1, role: { type: "member" } }],
    ["sales", { id: 2, role: { type: "member" } }],
    ["anonymous", null],
  ];
  const EXPECTED: Record<string, string[]> = {
    eng: ["page-draft-only", "page-eng", "page-moved-in", "page-moved-out", "page-open"],
    sales: ["page-draft-only", "page-moved-out", "page-open", "page-widened"],
    anonymous: ["page-draft-only", "page-moved-out", "page-open"],
  };

  it.each(CALLERS)(
    "lists exactly the pages whose deciding row is visible (%s)",
    async (name, user) => {
      const anchors = await visibleTargetAnchors(stub(), user);
      expect(anchors["wiki-page"].sort()).toEqual(EXPECTED[name]);
    },
  );

  it.each(CALLERS)(
    "isTargetVisible agrees with the list for every page (%s)",
    async (_name, user) => {
      const listed = new Set((await visibleTargetAnchors(stub(), user))["wiki-page"]);
      for (const documentId of PAGES) {
        await expect(
          isTargetVisible(stub(), "wiki-page", documentId, user),
          documentId,
        ).resolves.toBe(listed.has(documentId));
      }
    },
  );

  it("reads the pages without populating anything", async () => {
    const strapi = stub();
    await visibleTargetAnchors(strapi, { id: 1, role: { type: "member" } });
    const pageCalls = strapi.calls.filter((call) => call.uid === "api::wiki-page.wiki-page");
    expect(pageCalls.map((call) => call.params)).toEqual([
      { where: { space: { id: { $in: [1, 2, 3, 4, 6] } } }, select: ["documentId", "publishedAt"] },
      {
        where: {
          // Only a draft of these sits in a visible space.
          documentId: { $in: ["page-widened", "page-draft-only", "page-no-space"] },
          publishedAt: { $notNull: true },
        },
        select: ["documentId"],
      },
    ]);
  });
});

describe("wiki page anchors: bind limit (PL04)", () => {
  it("drops the draft-only pages when their lookup would exceed the bind limit", async () => {
    const count = 40_000;
    const error = vi.fn<(message: string) => void>();
    const pageQueries: unknown[] = [];
    const strapi = {
      db: {
        query: (uid: string) => ({
          findOne: async () => null,
          findMany: async (params: unknown) => {
            if (uid === "api::wiki-space.wiki-space") return [{ id: 1, visibility: "public" }];
            if (uid !== "api::wiki-page.wiki-page") return [];
            pageQueries.push(params);
            // Every page has only a draft in the visible space.
            return Array.from({ length: count }, (_, index) => ({
              documentId: `p${String(index).padStart(23, "0")}`,
              publishedAt: null,
            }));
          },
        }),
      },
      log: { error },
    };
    const anchors = await visibleTargetAnchors(strapi, null);
    expect(anchors["wiki-page"]).toEqual([]);
    // The second lookup (published rows elsewhere) with 40000 ids never ran.
    expect(pageQueries).toHaveLength(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(`comment targets: drafts: ${count} values`);
  });
});

describe("pinnedTargetAnchor (PL04 filter shapes)", () => {
  const eq = (value: unknown) => ({ $eq: value });
  const PIN = { targetType: "announcement", targetDocumentId: "k3v9q2m8x7c4b1n6p5z0r2t8" };
  const pinned = { targetType: eq(PIN.targetType), targetDocumentId: eq(PIN.targetDocumentId) };

  it.each<[string, unknown]>([
    ["the web's pair at the top level", pinned],
    ["the pair next to other conjuncts", { ...pinned, body: { $contains: "x" }, $or: [{ id: 1 }] }],
    ["the pair inside a top-level $and", { $and: [pinned, { id: { $gt: 3 } }] }],
    [
      "the pair split over $and items",
      {
        $and: [{ targetType: eq(PIN.targetType) }, { targetDocumentId: eq(PIN.targetDocumentId) }],
      },
    ],
    [
      "one key at the top level, one in $and",
      { targetType: eq(PIN.targetType), $and: [{ targetDocumentId: eq(PIN.targetDocumentId) }] },
    ],
    ["the same value twice", { ...pinned, $and: [pinned] }],
  ])("pins %s", (_label, filters) => {
    expect(pinnedTargetAnchor(filters)).toEqual(PIN);
  });

  it.each<[string, unknown]>([
    ["no filter", undefined],
    ["a string filter", "announcement"],
    ["an array filter", [pinned]],
    ["only the type", { targetType: eq("announcement") }],
    ["only the documentId", { targetDocumentId: eq(PIN.targetDocumentId) }],
    ["an $in list", { targetType: eq("announcement"), targetDocumentId: { $in: ["a"] } }],
    ["a bare string", { targetType: "announcement", targetDocumentId: eq("a") }],
    ["$eqi", { targetType: eq("announcement"), targetDocumentId: { $eqi: "a" } }],
    ["$eq plus $ne", { targetType: eq("announcement"), targetDocumentId: { $eq: "a", $ne: "b" } }],
    ["a non-string $eq", { targetType: eq("announcement"), targetDocumentId: eq(5) }],
    ["an array $eq", { targetType: eq("announcement"), targetDocumentId: eq(["a"]) }],
    ["two different documentIds", { ...pinned, $and: [{ targetDocumentId: eq("other") }] }],
    ["two different types", { ...pinned, $and: [{ targetType: eq("wiki-page") }] }],
    ["an $and object", { $and: { 0: pinned } }],
    ["a non-object in $and", { $and: [pinned, "x"] }],
    ["a pin only inside $or", { $or: [pinned] }],
    ["a pin only inside $not", { $not: pinned }],
    ["a pin nested two $and levels deep", { $and: [{ $and: [pinned] }] }],
  ])("takes the full path for %s", (_label, filters) => {
    expect(pinnedTargetAnchor(filters)).toBeNull();
  });
});
