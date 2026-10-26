import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import { MALFORMED_ROW_IDS, failLikePostgres } from "../utils/entry-id.test.helper";
import { MAX_ANCESTOR_WALK } from "../utils/wiki-write-targets";
import {
  writeAllowlistMessage,
  type StrapiDb,
  type WriteCaller,
  type WritePolicy,
} from "../utils/write-allowlist";
import canEditWiki from "./can-edit-wiki";

/**
 * Write gate for wiki pages (#24, FX07; rebuilt on the v2 write gate in
 * batch 16, utils/wiki-gate.ts): row gate + field allowlist.
 *
 * Row gate: admin_role and editor are the `moderator` class, enforced like
 * everyone (the bypass ended in batch 16); on CREATE (no target id) the
 * department heads and team leads (`author`); on UPDATE the page author,
 * the head of the page's department or the lead of the page's team, on
 * every row of the page (draft and published twin), and only while every
 * row sits in one space the caller can read.
 *
 * Field gate (FX07, the final-review finding "trusted wiki relations allow
 * cross-space disclosure"): the relation guard trusts wiki-page.parent/
 * children and wiki-space.pages, but the write side let a member point a
 * page they control at a hidden space or page (`{"data":{"parent":123}}`
 * with `?populate[parent]`), move another page's `revisions`, or place the
 * page in any `department`/`team`. Now:
 *   - create: content, a readable `space` (required), a `parent` in it;
 *     author/lastEditor are the caller,
 *   - update: content, `revisionSummary`, a `parent` that is a readable page
 *     of the same space and not the page or a descendant,
 *   - everything else is a 400 naming the key, and every refused parent or
 *     space answers byte-identically (no existence oracle).
 *
 * The fake DB is a plain in-memory table set that understands the `where`
 * shapes the policy uses (id, documentId, documentId $in). Every space and
 * page has a draft row and (mostly) a published row, like Strapi's draft &
 * publish; drafts link to drafts, published rows to published rows.
 */

type Row = { id: number } & Record<string, unknown>;
type Tables = Record<string, Row[]>;

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";
const USER = "plugin::users-permissions.user";
const TEAM = "api::team.team";

const PUBLISHED = "2026-09-01T00:00:00.000Z";

/**
 * A page documentId in Strapi's shape (a cuid2: a lowercase letter and 23
 * letters or digits), which the canonical draft loader requires of a route
 * id: `pid("page-own")` is "pageownxxxxxxxxxxxxxxxxx".
 */
const pid = (name: string) => name.replace(/-/g, "").padEnd(24, "x");

const ROLE = { member: 21, departmentHead: 22, teamLead: 23, exec: 25 };
const ENGINEERING = 10;
const FRONTEND_TEAM = 30;

const AUTHOR = 1;
const HEAD = 2;
const LEAD = 3;
const OUTSIDER = 5;
const OTHER_HEAD = 6;
const OTHER_LEAD = 8;

const USERS: Row[] = [
  {
    id: AUTHOR,
    role: { id: ROLE.member, type: "member" },
    department: { id: ENGINEERING },
    teams: [{ id: FRONTEND_TEAM }],
  },
  {
    id: HEAD,
    role: { id: ROLE.departmentHead, type: "department_head" },
    department: { id: ENGINEERING },
    teams: [],
  },
  {
    id: LEAD,
    role: { id: ROLE.teamLead, type: "team_lead" },
    department: null,
    teams: [{ id: FRONTEND_TEAM }],
  },
  { id: OUTSIDER, role: { id: ROLE.member, type: "member" }, department: { id: 11 }, teams: [] },
  {
    id: OTHER_HEAD,
    role: { id: ROLE.departmentHead, type: "department_head" },
    department: { id: 11 },
    teams: [],
  },
  { id: OTHER_LEAD, role: { id: ROLE.teamLead, type: "team_lead" }, department: null, teams: [] },
];

/** A space document: [draft row id, published row id | null] and its visibility per row. */
function space(
  documentId: string,
  draftId: number,
  publishedId: number | null,
  visibility: Record<string, unknown>,
  draftVisibility: Record<string, unknown> = visibility,
): Row[] {
  const rows: Row[] = [{ id: draftId, documentId, publishedAt: null, ...draftVisibility }];
  if (publishedId !== null) {
    rows.push({ id: publishedId, documentId, publishedAt: PUBLISHED, ...visibility });
  }
  return rows;
}

const PUBLIC = { visibility: "public" };
const EXEC_ONLY = { visibility: "role", allowedRoles: [{ id: ROLE.exec }] };
const FRONTEND_ONLY = { visibility: "team", team: { id: FRONTEND_TEAM } };

const SPACES: Row[] = [
  ...space("space-handbook", 100, 101, PUBLIC),
  ...space("space-exec", 110, 111, EXEC_ONLY),
  ...space("space-frontend", 120, 121, FRONTEND_ONLY),
  ...space("space-draftonly", 130, null, PUBLIC),
  // Published public, but an unpublished draft restricts it.
  ...space("space-moving", 140, 141, PUBLIC, EXEC_ONLY),
];

const SPACE_ROWS: Record<string, [number, number]> = {
  handbook: [100, 101],
  exec: [110, 111],
  frontend: [120, 121],
};

interface PageSpec {
  documentId: string;
  ids: [number, number | null];
  /** Space of the draft row and of the published row. */
  space: [string | null, string | null];
  parent?: string;
  author?: number;
  department?: number;
  team?: { id: number; lead: { id: number } };
}

/** Draft rows link to the draft space/parent row, published rows to published ones. */
function pageRows(spec: PageSpec, all: PageSpec[]): Row[] {
  const link = (spaceKey: string | null, draft: boolean) => {
    if (!spaceKey) return null;
    const [draftId, publishedId] = SPACE_ROWS[spaceKey];
    return { id: draft ? draftId : publishedId, documentId: `space-${spaceKey}` };
  };
  const parentLink = (draft: boolean) => {
    const parent = all.find((p) => p.documentId === spec.parent);
    if (!parent) return null;
    return { id: draft ? parent.ids[0] : parent.ids[1], documentId: parent.documentId };
  };
  const common = {
    documentId: spec.documentId,
    author: spec.author ? { id: spec.author } : null,
    department: spec.department ? { id: spec.department } : null,
    team: spec.team ?? null,
  };
  const rows: Row[] = [
    {
      id: spec.ids[0],
      publishedAt: null,
      space: link(spec.space[0], true),
      parent: parentLink(true),
      ...common,
    },
  ];
  if (spec.ids[1] !== null) {
    rows.push({
      id: spec.ids[1],
      publishedAt: PUBLISHED,
      space: link(spec.space[1], false),
      parent: parentLink(false),
      ...common,
    });
  }
  return rows;
}

const H: [string, string] = ["handbook", "handbook"];

const PAGE_SPECS: PageSpec[] = [
  { documentId: pid("page-own"), ids: [200, 201], space: H, author: AUTHOR },
  { documentId: pid("page-sibling"), ids: [210, 211], space: H, author: OUTSIDER },
  { documentId: pid("page-secret"), ids: [220, 221], space: ["exec", "exec"], author: OUTSIDER },
  {
    documentId: pid("page-child"),
    ids: [230, 231],
    space: H,
    parent: pid("page-own"),
    author: OUTSIDER,
  },
  { documentId: pid("page-grandchild"), ids: [240, 241], space: H, parent: pid("page-child") },
  { documentId: pid("page-draft"), ids: [250, null], space: H, author: OUTSIDER },
  // Published in the handbook, but an editor's unpublished move put the draft in exec.
  { documentId: pid("page-moved"), ids: [260, 261], space: ["exec", "handbook"], author: AUTHOR },
  { documentId: pid("page-in-hidden"), ids: [270, 271], space: ["exec", "exec"], author: AUTHOR },
  { documentId: pid("page-no-space"), ids: [280, 281], space: [null, null], author: AUTHOR },
  {
    documentId: pid("page-dept"),
    ids: [290, 291],
    space: H,
    author: OUTSIDER,
    department: ENGINEERING,
  },
  {
    documentId: pid("page-team"),
    ids: [300, 301],
    space: H,
    author: OUTSIDER,
    team: { id: FRONTEND_TEAM, lead: { id: LEAD } },
  },
  { documentId: pid("page-frontend"), ids: [310, 311], space: ["frontend", "frontend"] },
  { documentId: pid("page-mixed"), ids: [320, 321], space: ["exec", "handbook"] },
  // An admin-made loop that does not involve page-own: the walk must end.
  { documentId: pid("page-loop-a"), ids: [330, 331], space: H, parent: pid("page-loop-b") },
  { documentId: pid("page-loop-b"), ids: [340, 341], space: H, parent: pid("page-loop-a") },
];

function tables(extraPages: PageSpec[] = []): Tables {
  const specs = [...PAGE_SPECS, ...extraPages];
  return {
    [USER]: USERS,
    [TEAM]: [{ id: FRONTEND_TEAM, lead: { id: LEAD } }],
    [SPACE]: SPACES,
    [PAGE]: specs.flatMap((spec) => pageRows(spec, specs)),
  };
}

interface Params {
  where?: Record<string, unknown>;
}

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    // The paged space read (utils/paged-read.ts, #175): `$and` and the id cursor.
    if (key === "$and") {
      return (condition as Record<string, unknown>[]).every((part) => matches(row, part));
    }
    if (condition !== null && typeof condition === "object" && "$gt" in condition) {
      return (row[key] as number) > (condition as { $gt: number }).$gt;
    }
    if (condition !== null && typeof condition === "object" && "$in" in condition) {
      return (condition as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === condition;
  });
}

/** Every `where` a lookup ran with; fails like Postgres on a value an int4 `id` lookup cannot take. */
const lookups: Array<Record<string, unknown> | undefined> = [];
function lookup(where: Record<string, unknown> | undefined) {
  lookups.push(where);
  failLikePostgres(where);
}

function fakeStrapi(data: Tables = tables()): StrapiDb {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Params) => {
          lookup(params.where);
          return (data[uid] ?? []).find((row) => matches(row, params.where)) ?? null;
        },
        findMany: async (params: Params = {}) => {
          lookup(params.where);
          return (data[uid] ?? []).filter((row) => matches(row, params.where));
        },
      }),
    },
  };
}

interface Ctx extends WritePolicy {
  request: { body?: unknown; query: Record<string, unknown> };
}

function context(user: WriteCaller | null, id?: number | string, data: unknown = {}): Ctx {
  return {
    state: user ? { user } : {},
    request: { body: { data }, query: {} },
    params: { id },
  };
}

/** The route config every api/wiki-page route carries (the generic create/update: no intent). */
const CONFIG = { uid: PAGE };

const run = (ctx: Ctx, strapi: StrapiDb = fakeStrapi(), config: unknown = CONFIG) =>
  canEditWiki(ctx as never, config as never, { strapi: strapi as never });

const caller = (id: number): WriteCaller => {
  const role = USERS.find((u) => u.id === id)?.role as { type: string };
  return { id, role: { type: role.type } };
};

const dataOf = (ctx: Ctx) => (ctx.request.body as { data: Record<string, unknown> }).data;

async function refusal(promise: Promise<unknown>): Promise<{ message: string; details: unknown }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(errors.ValidationError);
  const { message, details } = error as InstanceType<typeof errors.ValidationError>;
  return { message, details };
}

const refusedAs = (keys: string[]) => ({ message: writeAllowlistMessage(keys), details: { keys } });
const cycleRefusal = {
  message: writeAllowlistMessage(["parent"]),
  details: { keys: ["parent"], codes: { parent: "parentCycle" } },
};

const MODERATOR = { id: 9, role: { type: "editor" } };
const ADMIN = { id: 9, role: { type: "admin_role" } };

describe("can-edit-wiki policy", () => {
  describe("row gate", () => {
    it("rejects an anonymous caller and a caller without a role type", async () => {
      await expect(run(context(null))).resolves.toBe(false);
      await expect(run(context({ id: AUTHOR }))).resolves.toBe(false);
    });

    it("no bypass: admin_role and editor are the moderator class, their payloads checked", async () => {
      for (const who of [ADMIN, MODERATOR]) {
        const data = { title: "T", space: 111, author: 5, revisions: { connect: [1] } };
        await expect(refusal(run(context(who, undefined, data)))).resolves.toEqual(
          refusedAs(["author", "revisions"]),
        );
        const update = { title: "T", space: 111 };
        await expect(refusal(run(context(who, pid("page-secret"), update)))).resolves.toEqual(
          refusedAs(["space"]),
        );
        await expect(run(context(who, pid("page-secret"), { title: "T" }))).resolves.toBe(true);
      }
    });

    it("refuses a route config without the wiki-page uid", async () => {
      for (const config of [undefined, {}, { uid: "api::wiki-space.wiki-space" }, { uid: 1 }]) {
        const ctx = context(caller(AUTHOR), pid("page-own"), { title: "A" });
        await expect(
          canEditWiki(ctx as never, config as never, { strapi: fakeStrapi() as never }),
          JSON.stringify(config),
        ).resolves.toBe(false);
      }
    });

    it("rejects a guest and a member on create (the creators: heads, leads, moderators)", async () => {
      const guest = { id: 7, role: { type: "guest" } };
      await expect(run(context(guest, undefined, { space: "space-handbook" }))).resolves.toBe(
        false,
      );
      await expect(
        run(context(caller(AUTHOR), undefined, { title: "T", space: "space-handbook" })),
      ).resolves.toBe(false);
    });

    it("allows the page author: the draft's and the published row's id, and the documentId", async () => {
      await expect(run(context(caller(AUTHOR), 200, { title: "A" }))).resolves.toBe(true);
      await expect(run(context(caller(AUTHOR), 201, { title: "A" }))).resolves.toBe(true);
      await expect(run(context(caller(AUTHOR), pid("page-own"), { title: "A" }))).resolves.toBe(
        true,
      );
    });

    it("needs the class on every row: a published twin by someone else refuses", async () => {
      const rows = tables();
      const twin = rows[PAGE].find((row) => row.id === 201) as Row;
      twin.author = { id: OUTSIDER };
      await expect(
        run(context(caller(AUTHOR), pid("page-own"), { title: "A" }), fakeStrapi(rows)),
      ).resolves.toBe(false);
      const dept = rows[PAGE].find((row) => row.id === 291) as Row;
      dept.department = { id: 11 };
      await expect(
        run(context(caller(HEAD), pid("page-dept"), { title: "A" }), fakeStrapi(rows)),
      ).resolves.toBe(false);
    });

    it("rejects a member who did not author the page", async () => {
      await expect(run(context(caller(AUTHOR), pid("page-sibling"), { title: "A" }))).resolves.toBe(
        false,
      );
    });

    it("returns false when the page does not exist (both id shapes)", async () => {
      await expect(run(context(caller(AUTHOR), 999, { title: "A" }))).resolves.toBe(false);
      await expect(run(context(caller(AUTHOR), "nope", { title: "A" }))).resolves.toBe(false);
    });

    it("returns false for a malformed or out-of-range id, without a lookup and never as a create", async () => {
      // A payload the create rule accepts: an update with a bad id must not
      // fall through to the create branch.
      const createPayload = { title: "A", space: "space-handbook" };
      await expect(run(context(caller(HEAD), undefined, createPayload))).resolves.toBe(true);
      lookups.length = 0;
      for (const id of MALFORMED_ROW_IDS) {
        await expect(run(context(caller(HEAD), id, { ...createPayload })), id).resolves.toBe(false);
      }
      expect(lookups).toEqual([]);
    });

    it("allows the head of the page's department, not of another", async () => {
      await expect(run(context(caller(HEAD), pid("page-dept"), { title: "A" }))).resolves.toBe(
        true,
      );
      await expect(
        run(context(caller(OTHER_HEAD), pid("page-dept"), { title: "A" })),
      ).resolves.toBe(false);
    });

    it("allows the lead of the page's team, not another team_lead", async () => {
      await expect(run(context(caller(LEAD), pid("page-team"), { title: "A" }))).resolves.toBe(
        true,
      );
      await expect(
        run(context(caller(OTHER_LEAD), pid("page-team"), { title: "A" })),
      ).resolves.toBe(false);
    });

    it.each([
      ["a space the caller cannot read", pid("page-in-hidden")],
      ["rows in different spaces (unpublished move)", pid("page-moved")],
      ["no space at all", pid("page-no-space")],
    ])("rejects the author of a page in %s (403, not 400)", async (_label, page) => {
      await expect(run(context(caller(AUTHOR), page, { title: "A" }))).resolves.toBe(false);
    });

    it("answers 403 before looking at the payload of a page the caller may not edit", async () => {
      const ctx = context(caller(AUTHOR), pid("page-sibling"), { parent: 221, members: [1] });
      await expect(run(ctx)).resolves.toBe(false);
    });
  });

  describe("create (department_head / team_lead hold the create grant)", () => {
    const content = {
      title: "Über uns",
      body: "# Willkommen",
      summary: null,
      tags: ["hr"],
      tocEnabled: true,
      order: 3,
    };

    it("accepts content in a readable space, forces author and lastEditor, derives the slug", async () => {
      const ctx = context(caller(HEAD), undefined, { ...content, space: "space-handbook" });
      await expect(run(ctx)).resolves.toBe(true);
      expect(dataOf(ctx)).toEqual({
        ...content,
        space: { set: [{ documentId: "space-handbook" }] },
        slug: expect.stringMatching(/^ueber-uns-[0-9a-f]{8}$/),
        author: HEAD,
        lastEditor: HEAD,
      });
    });

    it("review: a client slug is refused, so a unique-slug clash cannot probe hidden spaces", async () => {
      // POST {title, slug: "salaries", space: <public>} answered Strapi's
      // "This attribute must be unique" when a HIDDEN space used that slug.
      const ctx = context(caller(LEAD), undefined, {
        title: "x",
        slug: "salaries",
        space: "space-handbook",
      });
      await expect(refusal(run(ctx))).resolves.toEqual(refusedAs(["slug"]));
    });

    it("gives two pages with the same title different slugs", async () => {
      const slugs = new Set<unknown>();
      for (let i = 0; i < 5; i++) {
        const ctx = context(caller(HEAD), undefined, { title: "FAQ", space: "space-handbook" });
        await expect(run(ctx)).resolves.toBe(true);
        slugs.add(dataOf(ctx).slug);
      }
      expect(slugs.size).toBe(5);
    });

    it.each<[string, unknown]>([
      ["a documentId", "space-handbook"],
      ["the draft row id", 100],
      ["the published row id as a string", "101"],
      ["{ documentId }", { documentId: "space-handbook" }],
      ["{ connect }", { connect: [{ id: 101 }] }],
      ["{ set }", { set: ["space-handbook"] }],
      ["an array", [100]],
    ])("accepts the space as %s and stores its documentId", async (_label, spaceInput) => {
      const ctx = context(caller(LEAD), undefined, { title: "T", space: spaceInput });
      await expect(run(ctx)).resolves.toBe(true);
      expect(dataOf(ctx).space).toEqual({ set: [{ documentId: "space-handbook" }] });
    });

    it("accepts a space readable only through team membership", async () => {
      const ctx = context(caller(LEAD), undefined, { title: "T", space: "space-frontend" });
      await expect(run(ctx)).resolves.toBe(true);
    });

    it("refuses every unusable space with the same answer", async () => {
      const answers = [];
      for (const spaceInput of [
        undefined, // missing
        null,
        { set: [] },
        "space-exec", // hidden
        111, // hidden, published row id
        110, // hidden, draft row id
        "space-frontend", // readable for team members only, not for this head
        "space-draftonly", // never published
        "space-moving", // its draft row is hidden
        "space-ghost", // does not exist
        999999, // does not exist
      ]) {
        const data = spaceInput === undefined ? { title: "T" } : { title: "T", space: spaceInput };
        answers.push(await refusal(run(context(caller(HEAD), undefined, data))));
      }
      for (const answer of answers) expect(answer).toEqual(refusedAs(["space"]));
    });

    it("accepts a readable parent in the target space", async () => {
      const ctx = context(caller(HEAD), undefined, {
        title: "T",
        space: "space-handbook",
        parent: 211,
      });
      await expect(run(ctx)).resolves.toBe(true);
      expect(dataOf(ctx).parent).toEqual({ set: [{ documentId: pid("page-sibling") }] });
    });

    it("refuses a hidden, foreign-space, draft-only or unknown parent with the same answer", async () => {
      const answers = [];
      for (const parent of [
        221,
        pid("page-secret"),
        311,
        pid("page-draft"),
        pid("page-mixed"),
        424242,
      ]) {
        const data = { title: "T", space: "space-handbook", parent };
        answers.push(await refusal(run(context(caller(LEAD), undefined, data))));
      }
      for (const answer of answers) expect(answer).toEqual(refusedAs(["parent"]));
    });

    it("final review: a new page cannot be placed in a hidden space to read it back", async () => {
      // POST /api/wiki-pages?populate[space][populate][pages]=true
      const ctx = context(caller(HEAD), undefined, { title: "Probe", space: 111 });
      await expect(refusal(run(ctx))).resolves.toEqual(refusedAs(["space"]));
    });

    it.each<[string, Record<string, unknown>]>([
      ["author", { author: OUTSIDER }],
      ["lastEditor", { lastEditor: OUTSIDER }],
      ["department", { department: ENGINEERING }],
      ["team", { team: { connect: [FRONTEND_TEAM] } }],
      ["children", { children: { connect: [pid("page-secret")] } }],
      ["revisions", { revisions: [5] }],
      ["publishedAt", { publishedAt: PUBLISHED }],
      ["revisionSummary", { revisionSummary: "create has no revision" }],
    ])("refuses %s on create", async (key, extra) => {
      const ctx = context(caller(HEAD), undefined, {
        title: "T",
        space: "space-handbook",
        ...extra,
      });
      await expect(refusal(run(ctx))).resolves.toEqual(refusedAs([key]));
    });
  });

  describe("update (page author)", () => {
    const update = (data: Record<string, unknown>, page = pid("page-own"), who = AUTHOR) =>
      context(caller(who), page, data);

    it("accepts page content and revisionSummary unchanged", async () => {
      const data = {
        title: "Neu",
        body: "Text",
        summary: "Kurz",
        tags: null,
        tocEnabled: false,
        order: -1,
        revisionSummary: "Tippfehler",
      };
      const ctx = update(data);
      await expect(run(ctx)).resolves.toBe(true);
      // lastEditor is the caller (callerFields), never the client's.
      expect(dataOf(ctx)).toEqual({ ...data, lastEditor: AUTHOR });
    });

    it("final review: {parent: <hidden page id>} is refused", async () => {
      // PUT /api/wiki-pages/<own>?populate[parent]=true {"data":{"parent":221}}
      await expect(refusal(run(update({ parent: 221 })))).resolves.toEqual(refusedAs(["parent"]));
    });

    it.each<[string, unknown]>([
      ["its documentId", pid("page-sibling")],
      ["its draft row id", 210],
      ["its published row id", 211],
      ["{ documentId }", { documentId: pid("page-sibling") }],
      [
        "{ connect } with a disconnect of another same-space page",
        {
          connect: [{ id: 211 }],
          disconnect: [pid("page-dept")],
        },
      ],
      ["a page in an admin-made loop elsewhere in the space", pid("page-loop-a")],
    ])("accepts a readable same-space parent given as %s", async (_label, parent) => {
      const ctx = update({ parent });
      await expect(run(ctx)).resolves.toBe(true);
      const expected = parent === pid("page-loop-a") ? pid("page-loop-a") : pid("page-sibling");
      expect(dataOf(ctx).parent).toEqual({ set: [{ documentId: expected }] });
    });

    it("clears the parent with null and disconnects a readable same-space page", async () => {
      const cleared = update({ parent: null });
      await expect(run(cleared)).resolves.toBe(true);
      expect(dataOf(cleared).parent).toBeNull();
      const disconnected = update({ parent: { disconnect: [{ id: 211 }] } });
      await expect(run(disconnected)).resolves.toBe(true);
      expect(dataOf(disconnected).parent).toEqual({
        disconnect: [{ documentId: pid("page-sibling") }],
      });
    });

    it("refuses every unusable parent with the same answer (no existence oracle)", async () => {
      const answers = [];
      for (const parent of [
        221, // hidden space, published row
        220, // hidden space, draft row
        pid("page-secret"),
        { documentId: pid("page-secret") },
        { connect: [{ id: 221 }] },
        { disconnect: [pid("page-secret")] }, // even a disconnect must name readable rows
        { connect: [pid("page-sibling")], disconnect: [221] },
        pid("page-frontend"), // readable (team space), but another space
        pid("page-draft"), // never published
        pid("page-mixed"), // its draft sits in a hidden space
        pid("page-own"), // itself
        200, // itself by row id
        424242, // does not exist
        pid("page-ghost"), // does not exist
      ]) {
        answers.push(await refusal(run(update({ parent }))));
      }
      for (const answer of answers) expect(answer).toEqual(refusedAs(["parent"]));
    });

    it("refuses a NEW parent below the page with parentCycle (the early walk)", async () => {
      for (const parent of [pid("page-child"), pid("page-grandchild"), 231]) {
        await expect(refusal(run(update({ parent }))), String(parent)).resolves.toEqual(
          cycleRefusal,
        );
      }
    });

    it("does not walk for the stored parent: a title-only save inside a legacy loop passes", async () => {
      const loop: PageSpec[] = [
        {
          documentId: pid("page-mine-a"),
          ids: [500, 501],
          space: H,
          parent: pid("page-mine-b"),
          author: AUTHOR,
        },
        { documentId: pid("page-mine-b"), ids: [510, 511], space: H, parent: pid("page-mine-a") },
        { documentId: pid("page-mine-c"), ids: [520, 521], space: H, parent: pid("page-mine-a") },
      ];
      const strapi = fakeStrapi(tables(loop));
      const ctx = update({ title: "Renamed", parent: pid("page-mine-b") }, pid("page-mine-a"));
      await expect(run(ctx, strapi)).resolves.toBe(true);
      expect(dataOf(ctx).parent).toEqual({ set: [{ documentId: pid("page-mine-b") }] });
      // A real change into the loop still walks and refuses.
      await expect(
        refusal(run(update({ parent: pid("page-mine-c") }, pid("page-mine-a")), strapi)),
      ).resolves.toEqual(cycleRefusal);
    });

    it.each<[string, Record<string, unknown>]>([
      ["space, even the current one", { space: "space-handbook" }],
      ["space, a hidden one", { space: 111 }],
      ["children", { children: { connect: [221] } }],
      ["revisions (would move another page's history)", { revisions: { connect: [5] } }],
      ["author", { author: OUTSIDER }],
      ["lastEditor", { lastEditor: OUTSIDER }],
      ["department", { department: { connect: [ENGINEERING] } }],
      ["team", { team: FRONTEND_TEAM }],
      ["documentId", { documentId: pid("page-secret") }],
      ["locale", { locale: "en" }],
      ["slug (fixed after create; a new one would probe hidden slugs)", { slug: "salaries" }],
    ])("refuses %s", async (_label, data) => {
      await expect(refusal(run(update({ title: "T", ...data })))).resolves.toEqual(
        refusedAs(Object.keys(data)),
      );
    });

    it("refuses a parent chain too long to walk", async () => {
      const chain: PageSpec[] = Array.from({ length: MAX_ANCESTOR_WALK + 2 }, (_, i) => ({
        documentId: pid(`page-chain-${i}`),
        ids: [10_000 + 2 * i, 10_001 + 2 * i],
        space: H,
        parent: pid(`page-chain-${i + 1}`),
      }));
      const strapi = fakeStrapi(tables(chain));
      await expect(refusal(run(update({ parent: pid("page-chain-0") }), strapi))).resolves.toEqual(
        cycleRefusal,
      );
      // A short chain that does not reach the page is fine.
      await expect(
        run(update({ parent: pid(`page-chain-${MAX_ANCESTOR_WALK}`) }), strapi),
      ).resolves.toBe(true);
    });
  });

  describe("publication status (review: drafts through the write response)", () => {
    // PUT /api/wiki-pages/<own>?status=draft&populate[space][populate][pages]
    // answered with the DRAFT page row, whose space links the space's draft
    // row, whose pages are every draft of the space: never-published pages
    // and unpublished edits the read routes pin away. POST did the same for
    // a department head or team lead without owning any page.
    const drafty = (ctx: Ctx) => {
      ctx.request.query = {
        status: "draft",
        publicationState: "preview",
        populate: { space: { populate: { pages: true } } },
      };
      return ctx;
    };
    const pinned = { status: "published", populate: { space: { populate: { pages: true } } } };

    it("pins an update by the author, a head and a lead to status=published", async () => {
      for (const ctx of [
        context(caller(AUTHOR), pid("page-own"), { title: "A" }),
        context(caller(HEAD), pid("page-dept"), { title: "A" }),
        context(caller(LEAD), pid("page-team"), { title: "A" }),
      ]) {
        await expect(run(drafty(ctx))).resolves.toBe(true);
        expect(ctx.request.query).toEqual(pinned);
      }
    });

    it("pins a create by a department head or team lead to status=published", async () => {
      for (const who of [HEAD, LEAD]) {
        const ctx = drafty(
          context(caller(who), undefined, { title: "T", space: "space-handbook" }),
        );
        await expect(run(ctx)).resolves.toBe(true);
        expect(ctx.request.query).toEqual(pinned);
      }
    });

    it("pins the status on a refused payload too", async () => {
      const ctx = drafty(context(caller(AUTHOR), pid("page-own"), { children: [221] }));
      await expect(refusal(run(ctx))).resolves.toEqual(refusedAs(["children"]));
      expect(ctx.request.query.status).toBe("published");
    });

    it("leaves the status to the controller for admin_role and editor (they author drafts)", async () => {
      for (const who of [ADMIN, MODERATOR]) {
        for (const [id, data] of [
          [undefined, { title: "T", space: "space-handbook" }],
          [pid("page-own"), { title: "T" }],
        ] as const) {
          const ctx = drafty(context(who, id, data));
          await expect(run(ctx)).resolves.toBe(true);
          expect(ctx.request.query.status, `${who.role.type} ${id}`).toBe("draft");
        }
      }
    });
  });

  describe("update (department head / team lead classes)", () => {
    it("applies the same rules to the head of the page's department", async () => {
      const ok = context(caller(HEAD), pid("page-dept"), {
        body: "x",
        parent: pid("page-sibling"),
      });
      await expect(run(ok)).resolves.toBe(true);
      const hidden = context(caller(HEAD), pid("page-dept"), { parent: 221 });
      await expect(refusal(run(hidden))).resolves.toEqual(refusedAs(["parent"]));
      const moved = context(caller(HEAD), pid("page-dept"), { department: 11 });
      await expect(refusal(run(moved))).resolves.toEqual(refusedAs(["department"]));
    });

    it("applies the same rules to the lead of the page's team", async () => {
      const ok = context(caller(LEAD), pid("page-team"), { title: "x" });
      await expect(run(ok)).resolves.toBe(true);
      const foreign = context(caller(LEAD), pid("page-team"), { parent: pid("page-frontend") });
      await expect(refusal(run(foreign))).resolves.toEqual(refusedAs(["parent"]));
      const retarget = context(caller(LEAD), pid("page-team"), { team: null });
      await expect(refusal(run(retarget))).resolves.toEqual(refusedAs(["team"]));
    });
  });

  describe("the moderator class (batch 16)", () => {
    it("creates in any published space, hidden ones included, with department, team and a schedule", async () => {
      const ctx = context(MODERATOR, undefined, {
        title: "Ops runbook",
        space: "space-exec",
        department: ENGINEERING,
        team: null,
        revisionSummary: "first version",
      });
      const strapi = fakeStrapi({
        ...tables(),
        "api::department.department": [{ id: ENGINEERING, documentId: "dept-eng" }],
      });
      await expect(run(ctx, strapi)).resolves.toBe(true);
      expect(dataOf(ctx)).toEqual({
        title: "Ops runbook",
        space: { set: [{ documentId: "space-exec" }] },
        department: { set: [{ documentId: "dept-eng" }] },
        team: null,
        revisionSummary: "first version",
        slug: expect.stringMatching(/^ops-runbook-[0-9a-f]{8}$/),
        author: 9,
        lastEditor: 9,
      });
    });

    it("refuses a never-published space and a missing one", async () => {
      for (const space of ["space-draftonly", "space-ghost"]) {
        await expect(
          refusal(run(context(MODERATOR, undefined, { title: "T", space }))),
          space,
        ).resolves.toEqual(refusedAs(["space"]));
      }
    });

    it("takes a parent of the page's space, a draft-only one too, never one of another space", async () => {
      const draftParent = context(MODERATOR, pid("page-sibling"), { parent: pid("page-draft") });
      await expect(run(draftParent)).resolves.toBe(true);
      expect(dataOf(draftParent).parent).toEqual({ set: [{ documentId: pid("page-draft") }] });
      for (const parent of [
        pid("page-secret"),
        pid("page-frontend"),
        pid("page-sibling"),
        pid("page-ghost"),
      ]) {
        await expect(
          refusal(run(context(MODERATOR, pid("page-sibling"), { parent }))),
          String(parent),
        ).resolves.toEqual(refusedAs(["parent"]));
      }
      await expect(
        refusal(run(context(MODERATOR, pid("page-own"), { parent: pid("page-grandchild") }))),
      ).resolves.toEqual(cycleRefusal);
    });

    it("edits every page, hidden spaces included; no space move, no slug", async () => {
      await expect(run(context(MODERATOR, pid("page-in-hidden"), { body: "x" }))).resolves.toBe(
        true,
      );
      await expect(
        refusal(run(context(MODERATOR, pid("page-own"), { slug: "x", space: "space-exec" }))),
      ).resolves.toEqual(refusedAs(["slug", "space"]));
    });
  });

  describe("the custom actions (§J2)", () => {
    const action = (intent: string) => ({ uid: PAGE, intent });
    const notFound = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(errors.NotFoundError);
    };

    it("answers 404 on a page action without a class, true with one", async () => {
      for (const intent of ["editable", "publish", "discardDraft", "revisions", "restore"]) {
        await notFound(
          run(context(caller(AUTHOR), pid("page-sibling")), undefined, action(intent)),
        );
        await expect(
          run(context(caller(AUTHOR), pid("page-own")), undefined, action(intent)),
          intent,
        ).resolves.toBe(true);
      }
      await notFound(run(context(caller(AUTHOR), "nope"), undefined, action("editable")));
    });

    it("gives unpublish and the list to moderators only", async () => {
      await notFound(run(context(caller(AUTHOR), pid("page-own")), undefined, action("unpublish")));
      await expect(
        run(context(MODERATOR, pid("page-own")), undefined, action("unpublish")),
      ).resolves.toBe(true);
      await expect(run(context(caller(HEAD)), undefined, action("authoringList"))).resolves.toBe(
        false,
      );
      await expect(run(context(MODERATOR), undefined, action("authoringList"))).resolves.toBe(true);
    });

    it("lets every wiki-page updater list their drafts; createDraft is the creators'", async () => {
      for (const who of [caller(AUTHOR), caller(HEAD), caller(LEAD), MODERATOR]) {
        await expect(run(context(who), undefined, action("myDrafts"))).resolves.toBe(true);
      }
      await expect(
        run(context({ id: 7, role: { type: "guest" } }), undefined, action("myDrafts")),
      ).resolves.toBe(false);
      const draft = context(caller(LEAD), undefined, { title: "T", space: "space-handbook" });
      draft.request.query = { status: "published" };
      await expect(run(draft, undefined, action("createDraft"))).resolves.toBe(true);
      // The draft actions never touch the status: the controller refuses a query.
      expect(draft.request.query).toEqual({ status: "published" });
      await expect(
        run(context(caller(AUTHOR), undefined, { title: "T" }), undefined, action("createDraft")),
      ).resolves.toBe(false);
    });

    it("checks a saveDraft payload with the class's update rule", async () => {
      const ctx = context(caller(AUTHOR), pid("page-own"), { title: "T", department: ENGINEERING });
      await expect(refusal(run(ctx, undefined, action("saveDraft")))).resolves.toEqual(
        refusedAs(["department"]),
      );
    });
  });
});
