import { describe, expect, it } from "vitest";
import pollVisibility, { type PollVisibilityHost } from "./poll-visibility";

/**
 * Wiring test for the poll read policy (decision 02), in the strapi-stub
 * pattern of quick-link-visibility.test.ts. The rules themselves are pinned
 * in utils/poll-audience.test.ts; this file pins the query side:
 *   - no user → false; admin_role/editor → true with the query untouched,
 *   - the visible ids come from PUBLISHED rows only (the findMany `where`),
 *   - departments match by documentId (a user linked to row 1 and a poll
 *     linked to row 2 of the same department document still match),
 *   - an empty list stays restrictive ({ id: { $eq: -1 } }, never $in: []),
 *   - a client filter is $and-wrapped, the status pinned to published, the
 *     legacy publicationState removed, and the result is a strict true,
 *   - guests (owner decision 2026-09-27) get only the polls that are
 *     visibleToGuests AND in their audience; every other role is unchanged
 *     by the guest flags.
 */

interface StubUser {
  id: number;
  role?: { type: string };
  department?: { id: number; documentId: string } | null;
}

interface PollRow {
  id: number;
  audience?: string | null;
  departments?: { id: number; documentId: string }[];
  publishedAt: string | null;
  visibleToGuests?: boolean | null;
  guestsCanVote?: boolean | null;
}

const PUBLISHED = "2026-09-01T00:00:00.000Z";

/** 1 company-wide, 2 Engineering, 3 Design, 4 Eng+Design, 5 orphaned, 6 legacy 'all' + Eng, 7 a draft. */
const POLLS: PollRow[] = [
  { id: 1, audience: "all", departments: [], publishedAt: PUBLISHED },
  {
    id: 2,
    audience: "departments",
    departments: [{ id: 2, documentId: "d-eng" }],
    publishedAt: PUBLISHED,
  },
  {
    id: 3,
    audience: "departments",
    departments: [{ id: 3, documentId: "d-design" }],
    publishedAt: PUBLISHED,
  },
  {
    id: 4,
    audience: "departments",
    departments: [
      { id: 2, documentId: "d-eng" },
      { id: 3, documentId: "d-design" },
    ],
    publishedAt: PUBLISHED,
  },
  { id: 5, audience: "departments", departments: [], publishedAt: PUBLISHED },
  { id: 6, audience: "all", departments: [{ id: 2, documentId: "d-eng" }], publishedAt: PUBLISHED },
  { id: 7, audience: "all", departments: [], publishedAt: null },
];

function stub(users: StubUser[], polls: PollRow[] = POLLS) {
  const findManyCalls: Record<string, unknown>[] = [];
  const strapi: PollVisibilityHost = {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Record<string, unknown>) => {
          const where = params.where as { id: number };
          return uid === "plugin::users-permissions.user"
            ? (users.find((u) => u.id === where.id) ?? null)
            : null;
        },
        findMany: async (params: Record<string, unknown>) => {
          findManyCalls.push(params);
          if (uid !== "api::poll.poll") return [];
          const wantsPublished =
            (params.where as { publishedAt?: { $notNull?: boolean } } | undefined)?.publishedAt
              ?.$notNull === true;
          return polls.filter((p) => !wantsPublished || p.publishedAt !== null);
        },
      }),
    },
  };
  return { strapi, findManyCalls };
}

type Query = Record<string, unknown>;

function context(user: StubUser | null, query: Query = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  };
}

async function run(user: StubUser | null, query: Query = {}, polls?: PollRow[]) {
  const ctx = context(user, query);
  const { strapi, findManyCalls } = stub(user ? [user] : [], polls);
  const result = await pollVisibility(ctx, undefined, { strapi });
  return { result, query: ctx.request.query, findManyCalls };
}

const as = (type: string, department: StubUser["department"] = null): StubUser => ({
  id: 9,
  role: { type },
  department,
});

/** The user row links department row 1; the polls link row 2 of the same document. */
const ENG_ROW_1 = { id: 1, documentId: "d-eng" };

describe("poll-visibility policy", () => {
  it("refuses a request without a signed-in user", async () => {
    const { result, query } = await run(null);
    expect(result).toBe(false);
    expect(query.filters).toBeUndefined();
  });

  it("lets admin_role and editor through with the query untouched (drafts included)", async () => {
    for (const role of ["admin_role", "editor"]) {
      const { result, query, findManyCalls } = await run(as(role), { status: "draft" });
      expect(result, role).toBe(true);
      expect(query, role).toEqual({ status: "draft" });
      expect(findManyCalls, role).toEqual([]);
    }
  });

  it("matches departments by documentId, not by row id (twin regression)", async () => {
    const { query } = await run(as("member", ENG_ROW_1));
    expect(query.filters).toEqual({ id: { $in: [1, 2, 4, 6] } });
  });

  it("hides every poll from a guest while no poll is visible to guests (the default)", async () => {
    const { result, query } = await run(as("guest", { id: 3, documentId: "d-design" }));
    expect(result).toBe(true);
    expect(query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("shows a user without a department the company-wide polls only", async () => {
    for (const department of [null, undefined]) {
      const { query } = await run(as("member", department));
      expect(query.filters).toEqual({ id: { $in: [1] } });
    }
  });

  it("never lists a poll whose departments are gone (only admin/editor see it)", async () => {
    for (const role of ["member", "department_head", "team_lead", "authenticated"]) {
      const { query } = await run(as(role, ENG_ROW_1));
      expect((query.filters as { id: { $in: number[] } }).id.$in, role).not.toContain(5);
    }
    // Not even when it is visible to guests: no department left, no audience.
    const orphanedForGuests = POLLS.map((p) => (p.id === 5 ? { ...p, visibleToGuests: true } : p));
    const { query } = await run(as("guest", ENG_ROW_1), {}, orphanedForGuests);
    expect(query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("evaluates published rows only", async () => {
    const { query, findManyCalls } = await run(as("member", null));
    expect(findManyCalls).toEqual([
      {
        where: { publishedAt: { $notNull: true } },
        select: ["id", "audience", "visibleToGuests"],
        populate: { departments: { select: ["documentId"] } },
      },
    ]);
    expect((query.filters as { id: { $in: number[] } }).id.$in).not.toContain(7);
  });

  it("stays restrictive when nothing is visible (no fail-open empty $in)", async () => {
    const targetedOnly = POLLS.filter((p) => p.id === 2 || p.id === 3);
    const { query } = await run(as("member", null), {}, targetedOnly);
    expect(query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("keeps a client filter and only narrows it", async () => {
    const { query } = await run(as("member", ENG_ROW_1), {
      filters: { question: { $containsi: "pizza" } },
    });
    expect(query.filters).toEqual({
      $and: [{ question: { $containsi: "pizza" } }, { id: { $in: [1, 2, 4, 6] } }],
    });
  });

  it("pins the status to published and drops the legacy and cohort keys", async () => {
    const { query } = await run(as("member", null), {
      status: "draft",
      publicationState: "preview",
      publicationFilter: "modified",
      hasPublishedVersion: "false",
    });
    expect(query.status).toBe("published");
    expect("publicationState" in query).toBe(false);
    expect("publicationFilter" in query).toBe(false);
    expect("hasPublishedVersion" in query).toBe(false);
  });

  it("writes onto request.query, never the throw-away ctx.query copy", async () => {
    const ctx = { ...context(as("member", null)), query: {} as Query };
    const { strapi } = stub([as("member", null)]);
    await pollVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
    expect(ctx.query.filters).toBeUndefined();
  });

  it("returns a strict true for a reader", async () => {
    const { result } = await run(as("member", null));
    expect(result).toBe(true);
  });
});

describe("poll-visibility policy: guest access (owner decision 2026-09-27)", () => {
  const ENG = { id: 2, documentId: "d-eng" };
  const DESIGN = { id: 3, documentId: "d-design" };
  /**
   * 11 company-wide visible, 12 company-wide visible + votable, 13 company-wide
   * hidden (false), 14 company-wide NULL flags, 15 company-wide with only
   * guestsCanVote (inert), 16 Engineering visible, 17 Design visible,
   * 18 Engineering hidden, 19 a visible draft.
   */
  const GUEST_POLLS: PollRow[] = [
    {
      id: 11,
      audience: "all",
      departments: [],
      publishedAt: PUBLISHED,
      visibleToGuests: true,
      guestsCanVote: false,
    },
    {
      id: 12,
      audience: "all",
      departments: [],
      publishedAt: PUBLISHED,
      visibleToGuests: true,
      guestsCanVote: true,
    },
    {
      id: 13,
      audience: "all",
      departments: [],
      publishedAt: PUBLISHED,
      visibleToGuests: false,
      guestsCanVote: false,
    },
    {
      id: 14,
      audience: null,
      departments: [],
      publishedAt: PUBLISHED,
      visibleToGuests: null,
      guestsCanVote: null,
    },
    {
      id: 15,
      audience: "all",
      departments: [],
      publishedAt: PUBLISHED,
      visibleToGuests: false,
      guestsCanVote: true,
    },
    {
      id: 16,
      audience: "departments",
      departments: [ENG],
      publishedAt: PUBLISHED,
      visibleToGuests: true,
    },
    {
      id: 17,
      audience: "departments",
      departments: [DESIGN],
      publishedAt: PUBLISHED,
      visibleToGuests: true,
    },
    {
      id: 18,
      audience: "departments",
      departments: [ENG],
      publishedAt: PUBLISHED,
      visibleToGuests: false,
    },
    { id: 19, audience: "all", departments: [], publishedAt: null, visibleToGuests: true },
  ];

  const idsFor = async (user: StubUser) => {
    const { query } = await run(user, {}, GUEST_POLLS);
    return query.filters;
  };

  it("lists for a guest only the polls visible to guests in its audience", async () => {
    expect(await idsFor(as("guest", { id: 1, documentId: "d-eng" }))).toEqual({
      id: { $in: [11, 12, 16] },
    });
    expect(await idsFor(as("guest", DESIGN))).toEqual({ id: { $in: [11, 12, 17] } });
    expect(await idsFor(as("guest", null))).toEqual({ id: { $in: [11, 12] } });
  });

  it("never lists a hidden, NULL-flagged, vote-only or draft poll to a guest", async () => {
    for (const department of [null, ENG, DESIGN]) {
      const filters = (await idsFor(as("guest", department))) as { id: { $in: number[] } };
      for (const hidden of [13, 14, 15, 18, 19]) {
        expect(filters.id.$in, `${String(department?.documentId)} ${hidden}`).not.toContain(hidden);
      }
    }
  });

  it("keeps a guest's search inside the visible polls (the web search filters /api/polls)", async () => {
    const { query } = await run(
      as("guest", null),
      { filters: { question: { $containsi: "hidden" } }, status: "draft" },
      GUEST_POLLS,
    );
    expect(query.filters).toEqual({
      $and: [{ question: { $containsi: "hidden" } }, { id: { $in: [11, 12] } }],
    });
    expect(query.status).toBe("published");
  });

  it("stays restrictive for a guest when no poll is visible to guests", async () => {
    const hiddenOnly = GUEST_POLLS.filter((p) => p.visibleToGuests !== true);
    const { query } = await run(as("guest", ENG), {}, hiddenOnly);
    expect(query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("leaves every other role unchanged by the guest flags", async () => {
    for (const role of ["member", "department_head", "team_lead", "authenticated"]) {
      expect(await idsFor(as(role, { id: 1, documentId: "d-eng" })), role).toEqual({
        id: { $in: [11, 12, 13, 14, 15, 16, 18] },
      });
      expect(await idsFor(as(role, null)), role).toEqual({ id: { $in: [11, 12, 13, 14, 15] } });
    }
  });

  it("does not treat a lookalike role as a guest (nor as anything else)", async () => {
    // "Guest" is no users-permissions role type: it is no guest and no bypass,
    // so the plain audience rule applies to it like to any other role.
    expect(await idsFor(as("Guest", null))).toEqual({ id: { $in: [11, 12, 13, 14, 15] } });
  });

  it("keeps the admin_role/editor bypass: hidden polls stay readable for them", async () => {
    for (const role of ["admin_role", "editor"]) {
      const { result, query } = await run(as(role), {}, GUEST_POLLS);
      expect(result, role).toBe(true);
      expect(query.filters, role).toBeUndefined();
    }
  });
});
