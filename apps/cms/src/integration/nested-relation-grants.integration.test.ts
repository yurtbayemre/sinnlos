import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { todayIn } from "../utils/time";
import {
  TEST_ROLES,
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Relations followed inside a populate need the caller's `find` grant
 * (batch 15.2, docs/security.md "Relations in populate filters and sort").
 *
 * At the root, Strapi refuses a filter or sort through a relation whose
 * target the caller holds no `find` on (400 `Invalid key`). Inside a
 * populate's `filters` and `sort` it never asked (@strapi/utils 5.57), so
 * guest selected wiki pages by their department, and every role below
 * admin_role selected users by their role. The relation guard
 * (bootstrap/restricted-relation-guard.ts) now asks the same question there,
 * for every caller, admin_role and editor included:
 *   - per role, the relations it may not `find`, in filters (plain, `$or`,
 *     `$and`/`$not`, two populates deep) and sort (string, comma list,
 *     array, object): 400 with the core's message, and the answer is the
 *     same for a value that matches and one that does not; a role holding
 *     the grant gets an answer that depends on the value (the control);
 *   - nested filters through relations the role may read: as before; a
 *     sort inside a populate through any relation or media answers the
 *     core's 400 for every role, the grant held or not (batch 16: Strapi
 *     5.57 answered 500 with an SQL error there);
 *   - the row-level targets of the batch 15.2 review: comment.parent/replies
 *     (cut below the bypass by this release), department/team.pages (FX05),
 *     the wiki domain's own relations (trusted), wiki-page.revisions (closed,
 *     15.1) and course.lessons (training-visibility);
 *   - the web's own relation filters, in the exact shapes it sends.
 * Anonymous callers hold no content grant at all: every root answers 403.
 */

const SPACE = "api::wiki-space.wiki-space";
const PAGE = "api::wiki-page.wiki-page";
const COMMENT = "api::comment.comment";
const REACTION = "api::reaction.reaction";
const NOTIFICATION = "api::notification.notification";
const CLASSIFIED = "api::classified.classified";
const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const ROLE = "plugin::users-permissions.role";
const USER = "plugin::users-permissions.user";

/** In everything no caller below the bypass may read. */
const SECRET = "ZZSECRET";
/** A value nothing holds: the miss of every hit/miss pair. */
const NO_MATCH = "ZZNOMATCH";

const MODERATOR_ROLES: readonly TestRole[] = ["admin_role", "editor"];
/** Roles that hold department, team and user reads (guest holds no department.find). */
const ORG_READERS: readonly TestRole[] = TEST_ROLES.filter((role) => role !== "guest");
/** Every role but admin_role: none of them holds `users-permissions.role.find`. */
const ROLE_BLIND: readonly TestRole[] = TEST_ROLES.filter((role) => role !== "admin_role");
/** Roles that hold classified.find (guest does not). */
const AD_READERS: readonly TestRole[] = ORG_READERS;

const q = (value: string) => encodeURIComponent(value);
/** `path` with its `{v}` replaced by `value`, encoded. */
const withValue = (path: string, value: string) => path.replace("{v}", q(value));

interface Probe {
  label: string;
  /** `{v}` is replaced by the probed value (withValue). */
  path: string;
  /** A value that matches the fixture; sorts have none. */
  hit?: string;
  /** The relation the 400 names (`Invalid key <key>`). */
  key: string;
}

describe.each(testEngines())("relations in populate filters and sort need find on %s", (engine) => {
  let t: TestStrapi;
  let publicPage: Row;
  let childPage: Row;
  let visibleComment: Row;
  let hiddenComment: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const docs = (uid: string) => t.strapi.documents(uid);
    const { departments, teams, users } = t.fixtures;
    const memberRole = await t.strapi.db.query(ROLE).findOne({ where: { type: "member" } });
    if (!memberRole) throw new Error("fixture: the member role is missing");

    // A public space (every role reads it) whose pages link a department, a
    // team and authors; allowedRoles is set but ignored for `public`.
    const space = await docs(SPACE).create({
      data: {
        name: "IT NRG Space",
        slug: "it-nrg-space",
        visibility: "public",
        allowedRoles: [memberRole.id],
      },
      status: "published",
    });
    publicPage = await docs(PAGE).create({
      data: {
        title: "IT NRG Page",
        slug: "it-nrg-page",
        body: "visible",
        space: space.documentId,
        department: departments.engineering.documentId,
        team: teams.platform.documentId,
        author: users.member.id,
      },
      status: "published",
    });
    childPage = await docs(PAGE).create({
      data: {
        title: "IT NRG Child",
        slug: "it-nrg-child",
        body: "visible child",
        space: space.documentId,
        parent: publicPage.documentId,
        author: users.team_lead.id,
      },
      status: "published",
    });
    // A Sales space: hidden from every fixture user below the bypass (they
    // are in Engineering or in no department).
    const hiddenSpace = await docs(SPACE).create({
      data: {
        name: "IT NRG Hidden",
        slug: "it-nrg-hidden",
        visibility: "department",
        department: departments.sales.documentId,
      },
      status: "published",
    });
    const hiddenPage = await docs(PAGE).create({
      data: {
        title: `${SECRET} hidden page`,
        slug: "it-nrg-hidden-page",
        body: `${SECRET} hidden body`,
        space: hiddenSpace.documentId,
        department: departments.engineering.documentId,
        author: users.member.id,
      },
      status: "published",
    });

    // A comment under the hidden page, linked as the PARENT of a comment
    // under the public one: what a create before FX04 or the admin panel
    // could write.
    hiddenComment = await docs(COMMENT).create({
      data: {
        body: `${SECRET} hidden comment`,
        targetType: "wiki-page",
        targetDocumentId: hiddenPage.documentId,
        author: users.admin_role.id,
      },
    });
    visibleComment = await docs(COMMENT).create({
      data: {
        body: "IT NRG visible comment",
        targetType: "wiki-page",
        targetDocumentId: publicPage.documentId,
        author: users.member.id,
      },
    });
    await t.strapi.db
      .query(COMMENT)
      .update({ where: { id: visibleComment.id }, data: { parent: hiddenComment.id } });

    // member reports to department_head (the user → user probes).
    await t.strapi.db
      .query(USER)
      .update({ where: { id: users.member.id }, data: { manager: users.department_head.id } });

    // The web's own reads: a reaction and a notification per role, an ad
    // per ad reader.
    const expiresAt = todayIn().add({ days: 30 }).toString();
    for (const role of TEST_ROLES) {
      await docs(REACTION).create({
        data: {
          emoji: "heart",
          targetType: "wiki-page",
          targetDocumentId: publicPage.documentId,
          author: users[role].id,
        },
      });
      await t.strapi.db.query(NOTIFICATION).create({
        data: { type: "comment", title: `IT NRG note ${role}`, recipient: users[role].id },
      });
    }
    for (const role of AD_READERS) {
      await docs(CLASSIFIED).create({
        data: {
          title: `IT NRG ad ${role}`,
          description: "nested relation grants",
          category: "sale",
          expiresAt,
          author: users[role].id,
        },
      });
    }

    // Training: a published course with a lesson, and a draft-only one
    // (publish readiness keeps its lesson a draft too).
    const course = await docs(COURSE).create({
      data: { title: "IT NRG Course", slug: "it-nrg-course" },
      status: "published",
    });
    await docs(LESSON).create({
      data: { title: "IT NRG Lesson", course: course.documentId },
      status: "published",
    });
    const draftCourse = await docs(COURSE).create({
      data: { title: `${SECRET} draft course`, slug: "it-nrg-draft-course" },
    });
    await docs(LESSON).create({
      data: { title: `${SECRET} draft lesson`, course: draftCourse.documentId },
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  // -------------------------------------------------------------------------
  // The rule, per role
  // -------------------------------------------------------------------------

  /** Relations guest may not find: department and team. */
  const GUEST_PROBES: readonly Probe[] = [
    {
      label: "space → pages → department",
      path: "/api/wiki-spaces?populate[pages][filters][department][name][$eq]={v}",
      hit: "IT Engineering",
      key: "department",
    },
    {
      label: "team in a populate's $or",
      path:
        "/api/wiki-spaces?populate[pages][filters][$or][0][team][name][$eq]={v}" +
        "&populate[pages][filters][$or][1][id][$eq]=-1",
      hit: "IT Platform",
      key: "team",
    },
    {
      label: "author → department in $and/$not",
      path: "/api/wiki-pages?populate[author][filters][$and][0][$not][department][name][$eq]={v}",
      hit: "IT Engineering",
      key: "department",
    },
    {
      label: "two populates deep",
      path: "/api/wiki-spaces?populate[pages][populate][author][filters][department][name][$eq]={v}",
      hit: "IT Engineering",
      key: "department",
    },
    {
      label: "sort string",
      path: "/api/wiki-spaces?populate[pages][sort]=department.name:asc",
      key: "department",
    },
    {
      label: "sort comma list",
      path: "/api/wiki-spaces?populate[pages][sort]=title:asc,team.name:desc",
      key: "team",
    },
    {
      label: "sort array",
      path: "/api/wiki-spaces?populate[pages][sort][0]=team.name:desc",
      key: "team",
    },
    {
      label: "sort object",
      path: "/api/wiki-spaces?populate[pages][sort][department][name]=asc",
      key: "department",
    },
  ];

  /** The role relation: no role but admin_role may find it. */
  const ROLE_PROBES: readonly Probe[] = [
    {
      label: "page author's role",
      path: "/api/wiki-pages?populate[author][filters][role][type][$eq]={v}",
      hit: "member",
      key: "role",
    },
    {
      label: "space allowedRoles",
      path: "/api/wiki-pages?populate[space][filters][allowedRoles][type][$eq]={v}",
      hit: "member",
      key: "allowedRoles",
    },
    {
      label: "user → manager's role in $or",
      path:
        "/api/users?populate[manager][filters][$or][0][role][type][$eq]={v}" +
        "&populate[manager][filters][$or][1][id][$eq]=-1",
      hit: "department_head",
      key: "role",
    },
    {
      label: "sort by the author's role",
      path: "/api/wiki-pages?populate[author][sort]=role.type:asc",
      key: "role",
    },
    {
      label: "sort object by the manager's role",
      path: "/api/users?populate[manager][sort][role][name]=asc",
      key: "role",
    },
  ];

  /** admin_role is held to its own grants: no role holds users-permissions permission.find. */
  const ADMIN_PROBES: readonly Probe[] = [
    {
      label: "user → role → permissions",
      path: "/api/users?populate[role][filters][permissions][action][$eq]={v}",
      hit: `${PAGE}.find`,
      key: "permissions",
    },
    {
      label: "space allowedRoles → permissions",
      path: "/api/wiki-spaces?populate[allowedRoles][filters][permissions][action][$eq]={v}",
      hit: `${PAGE}.find`,
      key: "permissions",
    },
    {
      label: "sort by the role's permissions",
      path: "/api/users?populate[role][sort]=permissions.action:asc",
      key: "permissions",
    },
  ];

  const DENIED: ReadonlyArray<readonly [readonly TestRole[], readonly Probe[]]> = [
    [["guest"], GUEST_PROBES],
    [ROLE_BLIND, ROLE_PROBES],
    [["admin_role"], ADMIN_PROBES],
  ];

  it("answers 400 for every relation a role may not find, whatever the value", async () => {
    let checked = 0;
    for (const [roles, probes] of DENIED) {
      for (const probe of probes) {
        for (const role of roles) {
          const hit = await t.api(role, withValue(probe.path, probe.hit ?? ""));
          const miss = await t.api(role, withValue(probe.path, NO_MATCH));
          const { label } = probe;
          expect({ label, role, status: hit.status }).toEqual({ label, role, status: 400 });
          expect({
            label,
            role,
            blind: hit.status === miss.status && hit.text === miss.text,
          }).toEqual({ label, role, blind: true });
          expect({
            label,
            role,
            message: hit.text.includes(`Invalid key ${probe.key} at `),
          }).toEqual({ label, role, message: true });
          checked += 1;
        }
      }
    }
    // 8 guest probes, 5 role probes for six roles, 3 admin probes.
    expect(checked).toBe(8 + 5 * 6 + 3);
  });

  it("anonymous callers reach no root: 403 for every probe", async () => {
    for (const [, probes] of DENIED) {
      for (const probe of probes) {
        const res = await t.api(null, withValue(probe.path, probe.hit ?? ""));
        expect({ label: probe.label, status: res.status }).toEqual({
          label: probe.label,
          status: 403,
        });
      }
    }
  });

  it("the filter probes are oracles without the rule: a role holding the grant gets a value-dependent answer", async () => {
    // member holds department and team find; admin_role holds role find.
    const controls: ReadonlyArray<readonly [TestRole, string, string, string]> = [
      [
        "member",
        "/api/wiki-spaces?filters[slug][$eq]=it-nrg-space&populate[pages][filters][department][name][$eq]={v}&populate[pages][fields][0]=title",
        "IT Engineering",
        "IT NRG Page",
      ],
      [
        "member",
        "/api/wiki-spaces?filters[slug][$eq]=it-nrg-space&populate[pages][filters][team][name][$eq]={v}&populate[pages][fields][0]=title",
        "IT Platform",
        "IT NRG Page",
      ],
      [
        "admin_role",
        "/api/wiki-pages?filters[slug][$eq]=it-nrg-page&populate[author][filters][role][type][$eq]={v}&populate[author][fields][0]=username",
        "member",
        "it-member",
      ],
      [
        "admin_role",
        "/api/wiki-pages?filters[slug][$eq]=it-nrg-page&populate[space][filters][allowedRoles][type][$eq]={v}&populate[space][fields][0]=slug",
        "member",
        "it-nrg-space",
      ],
    ];
    for (const [role, path, hitValue, marker] of controls) {
      const hit = await t.api(role, withValue(path, hitValue));
      const miss = await t.api(role, withValue(path, NO_MATCH));
      expect({ path, role, status: hit.status }).toEqual({ path, role, status: 200 });
      expect({
        path,
        role,
        hit: hit.text.includes(marker),
        miss: miss.text.includes(marker),
      }).toEqual({ path, role, hit: true, miss: false });
    }
  });

  describe("nested filters through relations the role reads are unchanged; relation sorts are refused", () => {
    const pagesOf = (body: unknown) =>
      ((body as { data: { pages?: { title: string }[] }[] }).data[0]?.pages ?? []).map(
        (page) => page.title,
      );
    const spaceWith = (populate: string) =>
      `/api/wiki-spaces?filters[slug][$eq]=it-nrg-space&populate[pages][fields][0]=title&${populate}`;

    /**
     * A relation or media path in a populate's sort answers the core's 400
     * for every caller, also one that may find the target (batch 16).
     * Strapi 5.57 answered 500 there for such a caller, an SQL error in the
     * populate query (`no such column`), so nobody, the web included, could
     * use one.
     */
    async function expectSortRefused(role: TestRole, path: string, key: string) {
      const res = await t.api(role, path);
      expect({ role, path, status: res.status }).toEqual({ role, path, status: 400 });
      expect({ role, path, message: res.text.includes(`Invalid key ${key} at `) }).toEqual({
        role,
        path,
        message: true,
      });
    }

    it("every role: through users and the wiki domain's own relations", async () => {
      for (const role of TEST_ROLES) {
        const byAuthor = await t.api(
          role,
          spaceWith("populate[pages][filters][author][username][$eq]=it-member"),
        );
        expect({ role, status: byAuthor.status }).toEqual({ role, status: 200 });
        expect({ role, pages: pagesOf(byAuthor.body) }).toEqual({ role, pages: ["IT NRG Page"] });

        const nobody = await t.api(
          role,
          spaceWith("populate[pages][filters][author][username][$eq]=it-nobody"),
        );
        expect({ role, pages: pagesOf(nobody.body) }).toEqual({ role, pages: [] });

        for (const [order, expected] of [
          ["asc", ["IT NRG Child", "IT NRG Page"]],
          ["desc", ["IT NRG Page", "IT NRG Child"]],
        ] as const) {
          const sorted = await t.api(role, spaceWith(`populate[pages][sort]=title:${order}`));
          expect({ role, order, pages: pagesOf(sorted.body) }).toEqual({
            role,
            order,
            pages: expected,
          });
        }
        await expectSortRefused(
          role,
          spaceWith("populate[pages][sort]=author.username:asc"),
          "author",
        );

        const children = await t.api<{ data: { children?: { title: string }[] }[] }>(
          role,
          "/api/wiki-pages?filters[slug][$eq]=it-nrg-page" +
            "&populate[children][filters][space][slug][$eq]=it-nrg-space" +
            "&populate[children][filters][$or][0][parent][slug][$eq]=it-nrg-page" +
            "&populate[children][filters][$or][1][id][$eq]=-1&populate[children][fields][0]=title",
        );
        expect({ role, status: children.status }).toEqual({ role, status: 200 });
        expect({ role, children: children.body.data[0]?.children?.map((c) => c.title) }).toEqual({
          role,
          children: ["IT NRG Child"],
        });
      }
    });

    it("every role but guest: through departments and teams", async () => {
      for (const role of ORG_READERS) {
        const byDepartment = await t.api(
          role,
          spaceWith(`populate[pages][filters][department][name][$eq]=${q("IT Engineering")}`),
        );
        expect({ role, status: byDepartment.status }).toEqual({ role, status: 200 });
        expect({ role, pages: pagesOf(byDepartment.body) }).toEqual({
          role,
          pages: ["IT NRG Page"],
        });
        const teams = await t.api<{ data: { teams?: { name: string }[] }[] }>(
          role,
          `/api/departments?filters[name][$eq]=${q("IT Engineering")}` +
            "&populate[teams][filters][lead][username][$eq]=it-team-lead" +
            "&populate[teams][filters][department][name][$notNull]=true" +
            "&populate[teams][fields][0]=name",
        );
        expect({ role, status: teams.status }).toEqual({ role, status: 200 });
        expect({ role, teams: teams.body.data[0]?.teams?.map((team) => team.name) }).toEqual({
          role,
          teams: ["IT Platform"],
        });
        await expectSortRefused(role, spaceWith("populate[pages][sort]=team.name:asc"), "team");
        await expectSortRefused(
          role,
          `/api/departments?filters[name][$eq]=${q("IT Engineering")}&populate[teams][sort]=avatar.name:asc`,
          "avatar",
        );
        await expectSortRefused(
          role,
          `/api/departments?filters[name][$eq]=${q("IT Engineering")}&populate[teams][sort][lead][username]=asc`,
          "lead",
        );
      }
    });

    it("admin_role: through the role relation it may find", async () => {
      // /api/users answers a bare array (users-permissions).
      const res = await t.api<{ username: string; manager?: { username: string } | null }[]>(
        "admin_role",
        "/api/users?filters[username][$eq]=it-member" +
          "&populate[manager][filters][role][type][$eq]=department_head" +
          "&populate[manager][fields][0]=username",
      );
      expect(res.status).toBe(200);
      expect(res.body[0]?.manager?.username).toBe("it-department-head");
      await expectSortRefused(
        "admin_role",
        "/api/users?populate[manager][sort]=role.name:asc",
        "role",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Row-level targets (the batch 15.2 review table)
  // -------------------------------------------------------------------------

  describe("row-level targets", () => {
    const thread = () =>
      `/api/comments?filters[targetType][$eq]=wiki-page&filters[targetDocumentId][$eq]=${publicPage.documentId}`;
    const BELOW_BYPASS = TEST_ROLES.filter((role) => !MODERATOR_ROLES.includes(role));

    it("the comment fixture is not vacuous: the visible comment's parent is the hidden one", async () => {
      const row = await t.strapi.db
        .query(COMMENT)
        .findOne({ where: { id: visibleComment.id }, populate: { parent: { select: ["body"] } } });
      expect((row?.parent as { body?: string } | null)?.body).toBe(hiddenComment.body);
      // And the hidden thread itself stays hidden below the bypass.
      for (const role of BELOW_BYPASS) {
        const res = await t.api(role, "/api/comments?pagination[pageSize]=100");
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, leaks: res.text.includes(SECRET) }).toEqual({ role, leaks: false });
      }
    });

    it("comment.parent/replies: no populate, and filters and sort answer 400, below the bypass", async () => {
      const populates = [
        "&populate[parent]=true",
        "&populate[parent][fields][0]=body",
        "&populate[0]=parent&populate[1]=author",
        "&populate=*",
        "&populate[replies][count]=true",
      ];
      for (const role of BELOW_BYPASS) {
        for (const populate of populates) {
          const res = await t.api<{ data: Record<string, unknown>[] }>(role, thread() + populate);
          expect({ role, populate, status: res.status }).toEqual({ role, populate, status: 200 });
          expect({ role, populate, ids: res.body.data.map((row) => row.id) }).toEqual({
            role,
            populate,
            ids: [visibleComment.id],
          });
          expect({ role, populate, leaks: res.text.includes(SECRET) }).toEqual({
            role,
            populate,
            leaks: false,
          });
          expect(res.body.data[0]).not.toHaveProperty("parent");
          expect(res.body.data[0]).not.toHaveProperty("replies");
        }
        const probes: ReadonlyArray<readonly [string, string]> = [
          ["parent", `${thread()}&filters[parent][body][$startsWith]={v}`],
          [
            "replies",
            `/api/comments?filters[$or][0][replies][body][$startsWith]={v}&filters[$or][1][id][$eq]=-1`,
          ],
          ["parent", `${thread()}&sort=parent.body:asc`],
          ["parent", `/api/comments?populate[author][filters][id][$gt]=0&sort[0]=parent.body:desc`],
        ];
        for (const [key, path] of probes) {
          const hit = await t.api(role, withValue(path, SECRET));
          const miss = await t.api(role, withValue(path, NO_MATCH));
          expect({ role, path, status: hit.status }).toEqual({ role, path, status: 400 });
          expect({ role, path, blind: hit.text === miss.text }).toEqual({
            role,
            path,
            blind: true,
          });
          expect(hit.text).toContain(`Invalid key ${key}`);
        }
      }
    });

    it("comment.parent: admin_role and editor keep it (they read every comment anyway)", async () => {
      for (const role of MODERATOR_ROLES) {
        const res = await t.api<{ data: { parent?: { body: string } }[] }>(
          role,
          `${thread()}&populate[parent][fields][0]=body`,
        );
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect(res.body.data[0]?.parent?.body).toBe(hiddenComment.body);
        const filtered = await t.api<{ data: unknown[] }>(
          role,
          `${thread()}&filters[parent][body][$startsWith]=${SECRET}`,
        );
        expect({ role, rows: filtered.body.data.length }).toEqual({ role, rows: 1 });
      }
    });

    it("department.pages and team.pages inside a populate: 400 below the bypass (FX05)", async () => {
      const path = `/api/teams?populate[department][filters][pages][title][$startsWith]={v}`;
      for (const role of ORG_READERS) {
        const hit = await t.api(role, withValue(path, SECRET));
        const miss = await t.api(role, withValue(path, NO_MATCH));
        const moderator = MODERATOR_ROLES.includes(role);
        expect({ role, status: hit.status }).toEqual({ role, status: moderator ? 200 : 400 });
        if (!moderator) {
          expect({ role, blind: hit.text === miss.text }).toEqual({ role, blind: true });
          expect(hit.text).toContain("Invalid key pages at department.pages");
        }
      }
      const sorted = await t.api(
        "member",
        "/api/departments?populate[teams][sort]=pages.title:asc",
      );
      expect(sorted.status).toBe(400);
      expect(sorted.text).toContain("Invalid key pages at teams.pages");
    });

    it("the wiki domain's own relations stay inside what the root shows", async () => {
      for (const role of BELOW_BYPASS) {
        const res = await t.api<{ data: { slug: string }[] }>(
          role,
          `/api/wiki-spaces?populate[pages][filters][title][$startsWith]=${SECRET}` +
            `&populate[pages][populate][children][filters][body][$startsWith]=${SECRET}`,
        );
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, leaks: res.text.includes(SECRET) }).toEqual({ role, leaks: false });
        const hidden = res.body.data.some((row) => row.slug === "it-nrg-hidden");
        expect({ role, hidden }).toEqual({ role, hidden: false });
      }
      // Control: the moderators see the hidden space's page through it.
      const editor = await t.api(
        "editor",
        `/api/wiki-spaces?populate[pages][filters][title][$startsWith]=${SECRET}`,
      );
      expect(editor.text).toContain(`${SECRET} hidden page`);
    });

    it("wiki-page.revisions in a populate's object sort: closed for every role (15.1)", async () => {
      for (const role of TEST_ROLES) {
        const res = await t.api(
          role,
          "/api/wiki-spaces?populate[pages][sort][revisions][body]=asc",
        );
        expect({ role, status: res.status }).toEqual({ role, status: 400 });
        expect(res.text).toContain("Invalid key revisions at pages.revisions");
      }
    });

    it("course.lessons: nested filters stay with the published courses (training-visibility)", async () => {
      for (const role of ORG_READERS.filter((r) => !MODERATOR_ROLES.includes(r))) {
        const own = await t.api<{ data: { lessons?: { title: string }[] }[] }>(
          role,
          "/api/courses?filters[slug][$eq]=it-nrg-course" +
            "&populate[lessons][filters][course][slug][$eq]=it-nrg-course&populate[lessons][fields][0]=title",
        );
        expect({ role, status: own.status }).toEqual({ role, status: 200 });
        expect({ role, lessons: own.body.data[0]?.lessons?.map((l) => l.title) }).toEqual({
          role,
          lessons: ["IT NRG Lesson"],
        });
        const probe = await t.api(
          role,
          `/api/courses?populate[lessons][filters][title][$startsWith]=${SECRET}` +
            `&populate[lessons][populate][course][filters][title][$startsWith]=${SECRET}`,
        );
        expect({ role, status: probe.status }).toEqual({ role, status: 200 });
        expect({ role, leaks: probe.text.includes(SECRET) }).toEqual({ role, leaks: false });
      }
      expect((await t.api("guest", "/api/courses")).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // The web's relation filters (apps/web/src), exact shapes
  // -------------------------------------------------------------------------

  describe("the web's relation filters keep working for the roles that send them", () => {
    it("lib/api/wiki.ts wikiPageBySlug: filters[space][slug], every role", async () => {
      const path =
        "/api/wiki-pages?filters[space][slug][$eq]=it-nrg-space&filters[slug][$eq]=it-nrg-child" +
        "&populate[author][fields][0]=displayName&populate[author][fields][1]=username" +
        "&populate[lastEditor][fields][0]=displayName&populate[lastEditor][fields][1]=username" +
        "&populate[space][fields][0]=name&populate[space][fields][1]=slug";
      for (const role of TEST_ROLES) {
        const res = await t.api<{ data: Record<string, unknown>[] }>(role, path);
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, ids: res.body.data.map((row) => row.documentId) }).toEqual({
          role,
          ids: [childPage.documentId],
        });
      }
    });

    it("lib/notification-actions.ts getNotifications: filters[recipient][id], every role", async () => {
      for (const role of TEST_ROLES) {
        const id = t.fixtures.users[role].id;
        const list = await t.api<{ data: { title: string }[] }>(
          role,
          `/api/notifications?filters[recipient][id][$eq]=${id}&sort=createdAt:desc&pagination[pageSize]=20`,
        );
        expect({ role, status: list.status }).toEqual({ role, status: 200 });
        expect({ role, titles: list.body.data.map((row) => row.title) }).toEqual({
          role,
          titles: [`IT NRG note ${role}`],
        });
        const unread = await t.api<{ data: unknown[]; meta: { pagination: { total: number } } }>(
          role,
          `/api/notifications?filters[recipient][id][$eq]=${id}&filters[readAt][$null]=true&fields[0]=id&pagination[pageSize]=1`,
        );
        expect({ role, status: unread.status }).toEqual({ role, status: 200 });
        expect({ role, total: unread.body.meta.pagination.total }).toEqual({ role, total: 1 });
      }
    });

    it("lib/comment-actions.ts withOwnLookup: filters[author][id] on reactions, every role", async () => {
      for (const role of TEST_ROLES) {
        const id = t.fixtures.users[role].id;
        const res = await t.api<{ data: { author?: { id: number } }[] }>(
          role,
          `/api/reactions?filters[targetType][$eq]=wiki-page&filters[targetDocumentId][$eq]=${publicPage.documentId}` +
            `&filters[author][id][$eq]=${id}&populate[author]=true&pagination[pageSize]=25`,
        );
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, authors: res.body.data.map((row) => row.author?.id) }).toEqual({
          role,
          authors: [id],
        });
      }
    });

    it("lib/api/marketplace.ts myClassifieds: filters[author][id], every role that reads ads", async () => {
      for (const role of AD_READERS) {
        const id = t.fixtures.users[role].id;
        const res = await t.api<{ data: { title: string }[] }>(
          role,
          `/api/classifieds?filters[author][id][$eq]=${id}&populate[images]=true` +
            "&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[page]=1&pagination[pageSize]=100",
        );
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, titles: res.body.data.map((row) => row.title) }).toEqual({
          role,
          titles: [`IT NRG ad ${role}`],
        });
      }
    });
  });
});
