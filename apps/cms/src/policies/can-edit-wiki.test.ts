import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import { MAX_ANCESTOR_WALK } from "../utils/wiki-write-targets";
import {
  writeAllowlistMessage,
  type StrapiDb,
  type WriteCaller,
  type WritePolicy,
} from "../utils/write-allowlist";
import canEditWiki from "./can-edit-wiki";

/**
 * Write gate for wiki pages (#24, FX07): row gate + field allowlist.
 *
 * Row gate (unchanged): admin/editor bypass with the payload untouched; on
 * CREATE (no target id) any role but guest; on UPDATE the page author, the
 * head of the page's department or the lead of the page's team. New with
 * FX07: an update also needs every row of the page to sit in one space the
 * caller can read.
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
  { documentId: "page-own", ids: [200, 201], space: H, author: AUTHOR },
  { documentId: "page-sibling", ids: [210, 211], space: H, author: OUTSIDER },
  { documentId: "page-secret", ids: [220, 221], space: ["exec", "exec"], author: OUTSIDER },
  { documentId: "page-child", ids: [230, 231], space: H, parent: "page-own", author: OUTSIDER },
  { documentId: "page-grandchild", ids: [240, 241], space: H, parent: "page-child" },
  { documentId: "page-draft", ids: [250, null], space: H, author: OUTSIDER },
  // Published in the handbook, but an editor's unpublished move put the draft in exec.
  { documentId: "page-moved", ids: [260, 261], space: ["exec", "handbook"], author: AUTHOR },
  { documentId: "page-in-hidden", ids: [270, 271], space: ["exec", "exec"], author: AUTHOR },
  { documentId: "page-no-space", ids: [280, 281], space: [null, null], author: AUTHOR },
  { documentId: "page-dept", ids: [290, 291], space: H, author: OUTSIDER, department: ENGINEERING },
  {
    documentId: "page-team",
    ids: [300, 301],
    space: H,
    author: OUTSIDER,
    team: { id: FRONTEND_TEAM, lead: { id: LEAD } },
  },
  { documentId: "page-frontend", ids: [310, 311], space: ["frontend", "frontend"] },
  { documentId: "page-mixed", ids: [320, 321], space: ["exec", "handbook"] },
  // An admin-made loop that does not involve page-own: the walk must end.
  { documentId: "page-loop-a", ids: [330, 331], space: H, parent: "page-loop-b" },
  { documentId: "page-loop-b", ids: [340, 341], space: H, parent: "page-loop-a" },
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
    if (condition !== null && typeof condition === "object" && "$in" in condition) {
      return (condition as { $in: unknown[] }).$in.includes(row[key]);
    }
    return row[key] === condition;
  });
}

function fakeStrapi(data: Tables = tables()): StrapiDb {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Params) =>
          (data[uid] ?? []).find((row) => matches(row, params.where)) ?? null,
        findMany: async (params: Params = {}) =>
          (data[uid] ?? []).filter((row) => matches(row, params.where)),
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

const run = (ctx: Ctx, strapi: StrapiDb = fakeStrapi()) => canEditWiki(ctx, undefined, { strapi });

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

describe("can-edit-wiki policy", () => {
  describe("row gate", () => {
    it("rejects an anonymous caller and a caller without a role type", async () => {
      await expect(run(context(null))).resolves.toBe(false);
      await expect(run(context({ id: AUTHOR }))).resolves.toBe(false);
    });

    it("lets admin_role and editor through with any payload, untouched", async () => {
      for (const type of ["admin_role", "editor"]) {
        const data = { parent: 221, space: 111, author: 5, revisions: { connect: [1] } };
        const createCtx = context({ id: 9, role: { type } }, undefined, data);
        await expect(run(createCtx)).resolves.toBe(true);
        expect(dataOf(createCtx)).toEqual(data);
        const updateCtx = context({ id: 9, role: { type } }, "page-secret", data);
        await expect(run(updateCtx)).resolves.toBe(true);
        expect(dataOf(updateCtx)).toEqual(data);
      }
    });

    it("rejects a guest on create", async () => {
      const guest = { id: 7, role: { type: "guest" } };
      await expect(run(context(guest, undefined, { space: "space-handbook" }))).resolves.toBe(
        false,
      );
    });

    it("allows the page author — numeric id and documentId", async () => {
      await expect(run(context(caller(AUTHOR), 200, { title: "A" }))).resolves.toBe(true);
      await expect(run(context(caller(AUTHOR), "page-own", { title: "A" }))).resolves.toBe(true);
    });

    it("rejects a member who did not author the page", async () => {
      await expect(run(context(caller(AUTHOR), "page-sibling", { title: "A" }))).resolves.toBe(
        false,
      );
    });

    it("returns false when the page does not exist (both id shapes)", async () => {
      await expect(run(context(caller(AUTHOR), 999, { title: "A" }))).resolves.toBe(false);
      await expect(run(context(caller(AUTHOR), "nope", { title: "A" }))).resolves.toBe(false);
    });

    it("allows the head of the page's department, not of another", async () => {
      await expect(run(context(caller(HEAD), "page-dept", { title: "A" }))).resolves.toBe(true);
      await expect(run(context(caller(OTHER_HEAD), "page-dept", { title: "A" }))).resolves.toBe(
        false,
      );
    });

    it("allows the lead of the page's team, not another team_lead", async () => {
      await expect(run(context(caller(LEAD), "page-team", { title: "A" }))).resolves.toBe(true);
      await expect(run(context(caller(OTHER_LEAD), "page-team", { title: "A" }))).resolves.toBe(
        false,
      );
    });

    it.each([
      ["a space the caller cannot read", "page-in-hidden"],
      ["rows in different spaces (unpublished move)", "page-moved"],
      ["no space at all", "page-no-space"],
    ])("rejects the author of a page in %s (403, not 400)", async (_label, page) => {
      await expect(run(context(caller(AUTHOR), page, { title: "A" }))).resolves.toBe(false);
    });

    it("answers 403 before looking at the payload of a page the caller may not edit", async () => {
      const ctx = context(caller(AUTHOR), "page-sibling", { parent: 221, members: [1] });
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
      expect(dataOf(ctx).parent).toEqual({ set: [{ documentId: "page-sibling" }] });
    });

    it("refuses a hidden, foreign-space, draft-only or unknown parent with the same answer", async () => {
      const answers = [];
      for (const parent of [221, "page-secret", 311, "page-draft", "page-mixed", 424242]) {
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
      ["children", { children: { connect: ["page-secret"] } }],
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
    const update = (data: Record<string, unknown>, page = "page-own", who = AUTHOR) =>
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
      expect(dataOf(ctx)).toEqual(data);
    });

    it("final review: {parent: <hidden page id>} is refused", async () => {
      // PUT /api/wiki-pages/<own>?populate[parent]=true {"data":{"parent":221}}
      await expect(refusal(run(update({ parent: 221 })))).resolves.toEqual(refusedAs(["parent"]));
    });

    it.each<[string, unknown]>([
      ["its documentId", "page-sibling"],
      ["its draft row id", 210],
      ["its published row id", 211],
      ["{ documentId }", { documentId: "page-sibling" }],
      [
        "{ connect } with a disconnect of another same-space page",
        {
          connect: [{ id: 211 }],
          disconnect: ["page-dept"],
        },
      ],
      ["a page in an admin-made loop elsewhere in the space", "page-loop-a"],
    ])("accepts a readable same-space parent given as %s", async (_label, parent) => {
      const ctx = update({ parent });
      await expect(run(ctx)).resolves.toBe(true);
      const expected = parent === "page-loop-a" ? "page-loop-a" : "page-sibling";
      expect(dataOf(ctx).parent).toEqual({ set: [{ documentId: expected }] });
    });

    it("clears the parent with null and disconnects a readable same-space page", async () => {
      const cleared = update({ parent: null });
      await expect(run(cleared)).resolves.toBe(true);
      expect(dataOf(cleared).parent).toBeNull();
      const disconnected = update({ parent: { disconnect: [{ id: 211 }] } });
      await expect(run(disconnected)).resolves.toBe(true);
      expect(dataOf(disconnected).parent).toEqual({ disconnect: [{ documentId: "page-sibling" }] });
    });

    it("refuses every unusable parent with the same answer (no existence oracle)", async () => {
      const answers = [];
      for (const parent of [
        221, // hidden space, published row
        220, // hidden space, draft row
        "page-secret",
        { documentId: "page-secret" },
        { connect: [{ id: 221 }] },
        { disconnect: ["page-secret"] }, // even a disconnect must name readable rows
        { connect: ["page-sibling"], disconnect: [221] },
        "page-frontend", // readable (team space), but another space
        "page-draft", // never published
        "page-mixed", // its draft sits in a hidden space
        "page-own", // itself
        200, // itself by row id
        "page-child", // a child: would close a loop
        "page-grandchild", // a descendant further down
        424242, // does not exist
        "page-ghost", // does not exist
      ]) {
        answers.push(await refusal(run(update({ parent }))));
      }
      for (const answer of answers) expect(answer).toEqual(refusedAs(["parent"]));
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
      ["documentId", { documentId: "page-secret" }],
      ["locale", { locale: "en" }],
      ["slug (fixed after create; a new one would probe hidden slugs)", { slug: "salaries" }],
    ])("refuses %s", async (_label, data) => {
      await expect(refusal(run(update({ title: "T", ...data })))).resolves.toEqual(
        refusedAs(Object.keys(data)),
      );
    });

    it("refuses a parent chain too long to walk", async () => {
      const chain: PageSpec[] = Array.from({ length: MAX_ANCESTOR_WALK + 2 }, (_, i) => ({
        documentId: `page-chain-${i}`,
        ids: [10_000 + 2 * i, 10_001 + 2 * i],
        space: H,
        parent: `page-chain-${i + 1}`,
      }));
      const strapi = fakeStrapi(tables(chain));
      await expect(refusal(run(update({ parent: "page-chain-0" }), strapi))).resolves.toEqual(
        refusedAs(["parent"]),
      );
      // A short chain that does not reach the page is fine.
      await expect(
        run(update({ parent: `page-chain-${MAX_ANCESTOR_WALK}` }), strapi),
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
        context(caller(AUTHOR), "page-own", { title: "A" }),
        context(caller(HEAD), "page-dept", { title: "A" }),
        context(caller(LEAD), "page-team", { title: "A" }),
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
      const ctx = drafty(context(caller(AUTHOR), "page-own", { children: [221] }));
      await expect(refusal(run(ctx))).resolves.toEqual(refusedAs(["children"]));
      expect(ctx.request.query.status).toBe("published");
    });

    it("keeps ?status=draft for admin_role and editor (they author drafts)", async () => {
      for (const type of ["admin_role", "editor"]) {
        for (const id of [undefined, "page-own"]) {
          const ctx = drafty(context({ id: 9, role: { type } }, id, { title: "T" }));
          await expect(run(ctx)).resolves.toBe(true);
          expect(ctx.request.query.status, `${type} ${id}`).toBe("draft");
        }
      }
    });
  });

  describe("update (department head / team lead classes)", () => {
    it("applies the same rules to the head of the page's department", async () => {
      const ok = context(caller(HEAD), "page-dept", { body: "x", parent: "page-sibling" });
      await expect(run(ok)).resolves.toBe(true);
      const hidden = context(caller(HEAD), "page-dept", { parent: 221 });
      await expect(refusal(run(hidden))).resolves.toEqual(refusedAs(["parent"]));
      const moved = context(caller(HEAD), "page-dept", { department: 11 });
      await expect(refusal(run(moved))).resolves.toEqual(refusedAs(["department"]));
    });

    it("applies the same rules to the lead of the page's team", async () => {
      const ok = context(caller(LEAD), "page-team", { title: "x" });
      await expect(run(ok)).resolves.toBe(true);
      const foreign = context(caller(LEAD), "page-team", { parent: "page-frontend" });
      await expect(refusal(run(foreign))).resolves.toEqual(refusedAs(["parent"]));
      const retarget = context(caller(LEAD), "page-team", { team: null });
      await expect(refusal(run(retarget))).resolves.toEqual(refusedAs(["team"]));
    });
  });
});
