import { afterEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import { decodeOneParam, oneParamConnection, oneParamList } from "../test/narrowing.test.helper";
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
 *  - an announcement without a published row is no target at all, for
 *    every caller on writes (owner answer 2026-09-29 (b): the answer of a
 *    missing target),
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
      connection: oneParamConnection,
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
            const ids = (oneParamList(where?.space?.id?.$in) ?? []) as number[];
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
    // docC is a draft only: no target (owner answer 2026-09-29 (b)).
    expect(anchors.announcement.sort()).toEqual(["docA", "docB", "docD"]);
    expect(anchors["wiki-page"].sort()).toEqual(["pageP", "pageQ"]);
  });

  it("judges a mixed draft/published documentId by its PUBLISHED row", async () => {
    const anchors = await visibleTargetAnchors(stubStrapi(), designMember);
    // docD's draft is untargeted, but the published row is ENG-only.
    expect(anchors.announcement.sort()).toEqual(["docA"]);
    expect(anchors["wiki-page"]).toEqual(["pageP"]);
  });

  it("restricts anonymous callers to untargeted / public targets", async () => {
    const anchors = await visibleTargetAnchors(stubStrapi(), null);
    expect(anchors.announcement.sort()).toEqual(["docA"]);
    expect(anchors["wiki-page"]).toEqual(["pageP"]);
  });
});

describe("isTargetVisible", () => {
  it("bypasses for admin_role without resolving anything on a wiki page", async () => {
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
    await expect(isTargetVisible(bomb, "wiki-page", "pageQ", admin)).resolves.toBe(true);
  });

  it("checks only that an announcement is published for admin_role and editor", async () => {
    for (const moderator of [admin, { id: 98, role: { type: "editor" } }]) {
      // docB is ENG-scoped: the bypass still skips the audience.
      await expect(isTargetVisible(stubStrapi(), "announcement", "docB", moderator)).resolves.toBe(
        true,
      );
    }
  });

  it("refuses an unpublished announcement to everyone, like a missing one (owner 2026-09-29 (b))", async () => {
    for (const user of [engMember, designMember, admin, null]) {
      const label = String(user?.role.type ?? "anonymous");
      // docC exists as a draft only; "ghost" never existed.
      await expect(
        isTargetVisible(stubStrapi(), "announcement", "docC", user),
        label,
      ).resolves.toBe(false);
      await expect(
        isTargetVisible(stubStrapi(), "announcement", "ghost", user),
        label,
      ).resolves.toBe(false);
    }
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
    // Each list goes as one parameter (oneParamIn, #175); decoded for the comparison.
    expect(pageCalls.map((call) => decodeOneParam(call.params))).toEqual([
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

describe("wiki page anchors: past the old bind limit (#175)", () => {
  it("looks 40,000 draft-only pages up with one list and keeps them all", async () => {
    const count = 40_000;
    const documentIds = Array.from(
      { length: count },
      (_, index) => `p${String(index).padStart(23, "0")}`,
    );
    const pageQueries: unknown[] = [];
    const strapi = {
      db: {
        connection: oneParamConnection,
        query: (uid: string) => ({
          findOne: async () => null,
          findMany: async (params: { where?: { documentId?: unknown } }) => {
            if (uid === "api::wiki-space.wiki-space") return [{ id: 1, visibility: "public" }];
            if (uid !== "api::wiki-page.wiki-page") return [];
            pageQueries.push(decodeOneParam(params));
            // Every page has only a draft in the visible space, and none is
            // published elsewhere.
            return params.where?.documentId
              ? []
              : documentIds.map((documentId) => ({ documentId, publishedAt: null }));
          },
        }),
      },
    };
    const anchors = await visibleTargetAnchors(strapi as never, null);
    expect(anchors["wiki-page"]).toHaveLength(count);
    expect(pageQueries).toHaveLength(2);
    expect(pageQueries[1]).toEqual({
      where: { documentId: { $in: documentIds }, publishedAt: { $notNull: true } },
      select: ["documentId"],
    });
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

/**
 * DA02: an expired announcement is invisible like one outside the audience,
 * so its thread goes with it, in the list and in the single check alike;
 * the published row's expiry decides (the row the read policy serves).
 */
describe("expired announcements (DA02)", () => {
  const NOW = new Date("2026-09-29T10:00:00.000Z");
  const PAST = "2026-09-29T09:00:00.000Z";
  const FUTURE = "2026-09-30T00:00:00.000Z";
  const PUBLISHED = "2026-09-01T00:00:00.000Z";

  afterEach(() => {
    vi.useRealTimers();
  });

  function stub(): StrapiStub {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const row = (id: number, documentId: string, published: boolean, expiresAt: string | null) => ({
      id,
      documentId,
      title: documentId,
      audience: "all",
      publishedAt: published ? PUBLISHED : null,
      expiresAt,
    });
    return createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [{ id: 1, username: "eng", department: null, teams: [] }],
        "api::announcement.announcement": [
          row(1, "ann-live", true, FUTURE),
          row(2, "ann-live", false, FUTURE),
          row(3, "ann-ended", true, PAST),
          row(4, "ann-ended", false, PAST),
          // The published row has ended; a draft extends it (not yet published).
          row(5, "ann-extended-in-draft", true, PAST),
          row(6, "ann-extended-in-draft", false, FUTURE),
          row(7, "ann-no-end", true, null),
          row(8, "ann-no-end", false, null),
        ],
      },
    });
  }

  const member = { id: 1, role: { type: "member" } };

  it("leaves expired announcements out of the visible anchors", async () => {
    const anchors = await visibleTargetAnchors(stub(), member);
    expect(anchors.announcement.sort()).toEqual(["ann-live", "ann-no-end"]);
    expect((await visibleTargetAnchors(stub(), null)).announcement.sort()).toEqual([
      "ann-live",
      "ann-no-end",
    ]);
  });

  it("refuses the single check for an expired announcement, like the list", async () => {
    for (const documentId of ["ann-ended", "ann-extended-in-draft"]) {
      await expect(
        isTargetVisible(stub(), "announcement", documentId, member),
        documentId,
      ).resolves.toBe(false);
    }
    for (const documentId of ["ann-live", "ann-no-end"]) {
      await expect(
        isTargetVisible(stub(), "announcement", documentId, member),
        documentId,
      ).resolves.toBe(true);
    }
  });

  it("keeps the admin_role / editor bypass for expired announcements", async () => {
    for (const type of ["admin_role", "editor"]) {
      await expect(
        isTargetVisible(stub(), "announcement", "ann-ended", { id: 1, role: { type } }),
        type,
      ).resolves.toBe(true);
    }
  });
});

describe("announcements that target nobody (D-PT01, retargetRequired; batch 15)", () => {
  // The shared stub honours the select: without `retargetRequired` in it
  // the marked rows would be judged by their remaining criterion.
  const PUBLISHED = "2026-09-01T00:00:00.000Z";
  const ENG_ID = 10;
  const PLATFORM_ID = 30;

  function stub(): StrapiStub {
    const row = (id: number, documentId: string, published: boolean, extra: object) => ({
      id,
      documentId,
      title: documentId,
      publishedAt: published ? PUBLISHED : null,
      ...extra,
    });
    return createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [
          { id: 1, username: "eng", department: { id: ENG_ID }, teams: [{ id: PLATFORM_ID }] },
        ],
        "api::team.team": [{ id: PLATFORM_ID, lead: null }],
        "api::announcement.announcement": [
          row(1, "ann-eng", true, { audience: "departments", department: { id: ENG_ID } }),
          // D-PT01 on the published row.
          row(2, "ann-no-target", true, { audience: "departments" }),
          // The team was deleted: Engineering remains, the marker holds.
          row(3, "ann-marked", true, {
            audience: "departments",
            department: { id: ENG_ID },
            retargetRequired: true,
          }),
          // The department was deleted: Platform remains, the marker holds.
          row(4, "ann-marked-team", true, {
            audience: "departments",
            team: { id: PLATFORM_ID },
            retargetRequired: true,
          }),
          // A re-target in the draft does not open the published thread.
          row(5, "ann-retargeted-draft", true, {
            audience: "departments",
            department: { id: ENG_ID },
            retargetRequired: true,
          }),
          row(6, "ann-retargeted-draft", false, {
            audience: "departments",
            department: { id: ENG_ID },
            retargetRequired: false,
          }),
        ],
      },
    });
  }

  const member = { id: 1, role: { type: "member" } };
  const hidden = ["ann-no-target", "ann-marked", "ann-marked-team", "ann-retargeted-draft"];

  it("leaves them out of a member's visible anchors", async () => {
    const anchors = await visibleTargetAnchors(stub(), member);
    expect(anchors.announcement).toEqual(["ann-eng"]);
    expect((await visibleTargetAnchors(stub(), null)).announcement).toEqual([]);
  });

  it("refuses the single check like a missing target", async () => {
    for (const documentId of hidden) {
      await expect(
        isTargetVisible(stub(), "announcement", documentId, member),
        documentId,
      ).resolves.toBe(false);
    }
    await expect(isTargetVisible(stub(), "announcement", "ann-eng", member)).resolves.toBe(true);
  });

  it("keeps the admin_role / editor bypass for them", async () => {
    for (const type of ["admin_role", "editor"]) {
      for (const documentId of hidden) {
        await expect(
          isTargetVisible(stub(), "announcement", documentId, { id: 1, role: { type } }),
          `${type} ${documentId}`,
        ).resolves.toBe(true);
      }
    }
  });
});

describe("a department delete between the thread check's reads (batch 15)", () => {
  it("re-reads the marker after the relations, for the list and the single check", async () => {
    const UID = "api::announcement.announcement";
    const PLATFORM_ID = 30;
    const strapi = createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [
          { id: 1, username: "eng", department: { id: 10 }, teams: [{ id: PLATFORM_ID }] },
        ],
        "api::team.team": [{ id: PLATFORM_ID, lead: null }],
        [UID]: [
          {
            id: 1,
            documentId: "ann-torn",
            publishedAt: "2026-09-01T00:00:00.000Z",
            audience: "departments",
            team: { id: PLATFORM_ID },
            retargetRequired: true,
          },
        ],
      },
    });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const inner = query(uid);
      if (uid !== UID) return inner;
      return {
        ...inner,
        findMany: async (params) => {
          const rows = await inner.findMany(params);
          return params?.populate ? rows.map((row) => ({ ...row, retargetRequired: false })) : rows;
        },
      };
    };
    const member = { id: 1, role: { type: "member" } };
    expect((await visibleTargetAnchors(strapi, member)).announcement).toEqual([]);
    await expect(isTargetVisible(strapi, "announcement", "ann-torn", member)).resolves.toBe(false);
  });
});
