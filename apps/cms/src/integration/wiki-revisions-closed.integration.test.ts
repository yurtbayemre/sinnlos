import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TEST_ROLES,
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Wiki revisions are not readable through the content API (batch 15.1,
 * decision 06 §J3 "Generic routes", plan 16-0). The wiki-page lifecycle
 * snapshots the page body before every edit; whenever the draft differs
 * from the published version that body is unpublished draft text, and up to
 * batch 15 every staff role and `authenticated` could read it through
 * /api/wiki-revisions, `populate=revisions` and filters through the
 * relation. Every caller is checked, admin_role and editor included:
 *   - the generic routes are gone (404, or 405 where the path serves other
 *     methods), never a 401/403 that would mean "only the grant is missing";
 *   - a populate of `revisions`, in every shape and from every root that
 *     reaches a wiki page, comes back without it (the core drops a relation
 *     whose target the caller holds no `find` on);
 *   - a filter or sort through the relation either answers 400 or does not
 *     depend on the revisions' content: the core refuses root filters and
 *     sort, the relation guard (CLOSED_RELATION_TARGETS) the ones nested in
 *     a populate, which the core does not check at all;
 *   - the boot revokes the 18 grants a batch-15 database holds;
 *   - page reads and the lifecycle's revision writes are unchanged.
 */

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";
const REVISION = "api::wiki-revision.wiki-revision";
const PERMISSION = "plugin::users-permissions.permission";
const ROLE = "plugin::users-permissions.role";

/** In every never-published body; nothing a caller may read contains it. */
const SECRET = "ZZSECRET";
/** A prefix no revision has: the control of the oracle probes. */
const NO_MATCH = "ZZNOMATCH";

const CALLERS: readonly Caller[] = [...TEST_ROLES, null];
const who = (caller: Caller) =>
  caller === null ? "anonymous" : typeof caller === "string" ? caller : "jwt";

/** Roles that hold department, team and user reads (guest holds no department.find). */
const ORG_READERS: readonly TestRole[] = TEST_ROLES.filter((role) => role !== "guest");

/** The grants batch 15 wrote (its PERMISSION_MATRIX), which this release revokes. */
const BATCH_15_GRANTS: Readonly<Record<string, readonly string[]>> = {
  admin_role: ["find", "findOne", "create", "update", "delete"],
  editor: ["find", "findOne", "create", "update", "delete"],
  department_head: ["find", "findOne"],
  team_lead: ["find", "findOne"],
  member: ["find", "findOne"],
  authenticated: ["find", "findOne"],
};

describe.each(testEngines())("wiki revisions are closed on %s", (engine) => {
  let t: TestStrapi;
  let page: Row;
  let revision: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const docs = (uid: string) => t.strapi.documents(uid);
    const space = await docs(SPACE).create({
      data: { name: "IT Revisions Space", slug: "it-revisions-space", visibility: "public" },
      status: "published",
    });
    page = await docs(PAGE).create({
      data: {
        title: "IT Revisions Page",
        slug: "it-revisions-page",
        body: "ZZPUB-A first published version",
        space: space.documentId,
        department: t.fixtures.departments.engineering.documentId,
        team: t.fixtures.teams.platform.documentId,
        author: t.fixtures.users.member.id,
      },
      status: "published",
    });
    // Each draft save snapshots the body before it: B and D were never
    // published, and the publish in between links the revisions to the
    // published row too.
    const save = (body: string) =>
      docs(PAGE).update({ documentId: page.documentId, data: { body } });
    await save(`${SECRET}-B draft text that was never published`);
    await save("ZZPUB-C second published version");
    await docs(PAGE).publish({ documentId: page.documentId });
    await save(`${SECRET}-D draft text that was never published`);
    await save("ZZDRAFT-E the current draft");
    const secret = await t.strapi.db
      .query(REVISION)
      .findOne({ where: { body: { $startsWith: `${SECRET}-B` } } });
    if (!secret) throw new Error("fixture: the lifecycle wrote no revision of the draft text");
    revision = secret;
  });

  afterAll(async () => {
    await t?.stop();
  });

  /** Every revision body linked to the page's rows, read past the content API. */
  const linkedBodies = async (status: "draft" | "published") => {
    const row = await t.strapi.db.query(PAGE).findOne({
      where: {
        documentId: page.documentId,
        publishedAt: status === "draft" ? null : { $notNull: true },
      },
      populate: { revisions: { select: ["body"] } },
    });
    return ((row?.revisions ?? []) as { body: string }[]).map((entry) => entry.body);
  };

  it("the fixture is not vacuous: both page rows link revisions of never-published text", async () => {
    expect(await linkedBodies("published")).toEqual(
      expect.arrayContaining([expect.stringContaining(`${SECRET}-B`)]),
    );
    expect(await linkedBodies("draft")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${SECRET}-B`),
        expect.stringContaining(`${SECRET}-D`),
      ]),
    );
  });

  describe("the generic routes are gone", () => {
    const routes = (): ReadonlyArray<readonly [string, string]> => [
      ["GET", "/api/wiki-revisions"],
      ["GET", `/api/wiki-revisions/${revision.documentId}`],
      ["GET", `/api/wiki-revisions/${revision.id}`],
      ["POST", "/api/wiki-revisions"],
      ["PUT", `/api/wiki-revisions/${revision.documentId}`],
      ["DELETE", `/api/wiki-revisions/${revision.documentId}`],
    ];

    it("answer 404 or 405 for every caller, admin_role and editor included", async () => {
      for (const [method, path] of routes()) {
        for (const caller of CALLERS) {
          const res = await t.api(caller, path, {
            method,
            ...(method === "POST" || method === "PUT"
              ? { json: { data: { body: "x", page: page.documentId } } }
              : {}),
          });
          expect({ method, path, who: who(caller), status: res.status }).toEqual({
            method,
            path,
            who: who(caller),
            status: expect.toBeOneOf([404, 405]),
          });
          expect(res.text).not.toContain(SECRET);
        }
      }
      // Nothing was written or deleted through them.
      expect(
        await t.strapi.db.query(REVISION).findOne({ where: { id: revision.id } }),
      ).not.toBeNull();
      expect(await t.strapi.db.query(REVISION).count({ where: { body: "x" } })).toBe(0);
    });

    it("no role holds a wiki-revision grant after the boot", async () => {
      const rows = await t.strapi.db
        .query(PERMISSION)
        .findMany({ where: { action: { $startsWith: "api::wiki-revision." } } });
      expect(rows).toEqual([]);
    });
  });

  describe("populate through wiki-page.revisions returns no revision", () => {
    /** [label, path, roles]: every role that reads the root gets a 200 without revisions. */
    const probes = (): ReadonlyArray<readonly [string, string, readonly TestRole[]]> => [
      ["populate=revisions", "/api/wiki-pages?populate=revisions", TEST_ROLES],
      ["populate array", "/api/wiki-pages?populate[0]=revisions&populate[1]=space", TEST_ROLES],
      ["populate dotted", "/api/wiki-pages?populate=revisions.editor", TEST_ROLES],
      ["nested *", "/api/wiki-pages?populate[revisions][populate]=*", TEST_ROLES],
      ["count", "/api/wiki-pages?populate[revisions][count]=true", TEST_ROLES],
      ["populate=*", "/api/wiki-pages?populate=*", TEST_ROLES],
      ["findOne", `/api/wiki-pages/${page.documentId}?populate=revisions`, TEST_ROLES],
      ["draft rows", "/api/wiki-pages?status=draft&populate=revisions", TEST_ROLES],
      [
        "wiki-spaces → pages",
        "/api/wiki-spaces?populate[pages][populate][revisions]=true",
        TEST_ROLES,
      ],
      ["wiki-spaces → pages *", "/api/wiki-spaces?populate[pages][populate]=*", TEST_ROLES],
      [
        "children → revisions",
        "/api/wiki-pages?populate[children][populate][revisions]=true",
        TEST_ROLES,
      ],
      [
        "departments → pages",
        "/api/departments?populate[pages][populate][revisions]=true",
        ORG_READERS,
      ],
      ["teams → pages", "/api/teams?populate[pages][populate][revisions]=true", ORG_READERS],
      [
        "users/me → department → pages",
        "/api/users/me?populate[department][populate][pages][populate][revisions]=true",
        ORG_READERS,
      ],
    ];

    it("for every role, admin_role and editor included", async () => {
      for (const [label, path, roles] of probes()) {
        for (const role of roles) {
          const res = await t.api(role, path);
          expect({ label, role, status: res.status }).toEqual({ label, role, status: 200 });
          expect({ label, role, leaks: res.text.includes(SECRET) }).toEqual({
            label,
            role,
            leaks: false,
          });
          expect({ label, role, key: /"revisions"\s*:/.test(res.text) }).toEqual({
            label,
            role,
            key: false,
          });
        }
      }
    });

    it("the moderators' root populate still reaches the page through departments (control)", async () => {
      for (const role of ["admin_role", "editor"] as const) {
        const res = await t.api(role, "/api/departments?populate[pages][populate][revisions]=true");
        expect(res.text).toContain("IT Revisions Page");
      }
    });
  });

  describe("filters and sort through wiki-page.revisions are refused or blind", () => {
    const MODERATOR_ROLES: readonly TestRole[] = ["admin_role", "editor"];

    interface Probe {
      label: string;
      /** `{prefix}` is replaced by the probed prefix. */
      path: string;
      /** The roles that read the root. */
      roles: readonly TestRole[];
      /**
       * The roles answered with 400; the others get the relation that leads
       * there dropped first (department.pages and team.pages are cut for
       * every role without the bypass, FX05), a blind 200.
       */
      refused: readonly TestRole[];
    }
    const probe = (
      label: string,
      path: string,
      roles: readonly TestRole[] = TEST_ROLES,
      refused: readonly TestRole[] = roles,
    ): Probe => ({
      label,
      path,
      roles,
      refused,
    });

    const filters: readonly Probe[] = [
      probe("root filter", "/api/wiki-pages?filters[revisions][body][$startsWith]={prefix}"),
      probe(
        "filter in $or",
        "/api/wiki-pages?filters[$or][0][revisions][body][$startsWith]={prefix}&filters[$or][1][id][$eq]=-1",
      ),
      probe(
        "filter in $and/$not",
        "/api/wiki-pages?filters[$and][0][$not][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "deep filter through children",
        "/api/wiki-pages?filters[children][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "deep filter from wiki-spaces",
        "/api/wiki-spaces?filters[pages][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "filter nested in a populate",
        "/api/wiki-spaces?populate[pages][filters][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "filter nested two populates deep",
        "/api/wiki-spaces?populate[pages][populate][children][filters][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "filter in a populate's $or",
        "/api/wiki-spaces?populate[pages][filters][$or][0][revisions][body][$startsWith]={prefix}",
      ),
      probe(
        "filter nested in a department populate",
        "/api/departments?populate[pages][filters][revisions][body][$startsWith]={prefix}",
        ORG_READERS,
        MODERATOR_ROLES,
      ),
      probe(
        "filter nested under users/me",
        "/api/users/me?populate[department][populate][pages][filters][revisions][body][$startsWith]={prefix}",
        ORG_READERS,
        MODERATOR_ROLES,
      ),
    ];

    const sorts: readonly Probe[] = [
      probe("root sort", "/api/wiki-pages?sort=revisions.body:asc"),
      probe("root sort object", "/api/wiki-pages?sort[revisions][body]=asc"),
      probe(
        "sort nested in a populate",
        "/api/wiki-spaces?populate[pages][sort]=revisions.body:asc",
      ),
    ];

    it("a filter answers the same whatever the revisions hold, for every role", async () => {
      for (const { label, path, roles } of filters) {
        for (const role of roles) {
          const hit = await t.api(role, path.replace("{prefix}", SECRET));
          const miss = await t.api(role, path.replace("{prefix}", NO_MATCH));
          expect({ label, role, status: hit.status }).toEqual({
            label,
            role,
            status: expect.toBeOneOf([200, 400]),
          });
          expect({
            label,
            role,
            blind: hit.status === miss.status && hit.text === miss.text,
          }).toEqual({ label, role, blind: true });
          expect(hit.text).not.toContain(SECRET);
        }
      }
    });

    it("pins how: the core's or the guard's 400, or the FX05 cut first (Strapi 5.57)", async () => {
      for (const { label, path, roles, refused } of [...filters, ...sorts]) {
        for (const role of roles) {
          const res = await t.api(role, path.replace("{prefix}", SECRET));
          const status = refused.includes(role) ? 400 : 200;
          expect({ label, role, status: res.status }).toEqual({ label, role, status });
          if (status === 400) expect(res.text).toContain("Invalid key revisions");
        }
      }
    });
  });

  describe("writes through the relation", () => {
    it("admin_role and editor cannot connect a revision to another page through the content API", async () => {
      const other = await t.strapi.documents(PAGE).create({
        data: { title: "IT Other Page", slug: "it-other-page", body: "other" },
        status: "published",
      });
      for (const role of ["admin_role", "editor"] as const) {
        const res = await t.api(role, `/api/wiki-pages/${other.documentId}`, {
          method: "PUT",
          json: { data: { revisions: { connect: [revision.documentId] } } },
        });
        // The core's input validation: no `wiki-revision.find`, no relation.
        expect({ role, status: res.status }).toEqual({ role, status: 400 });
        expect(res.text).toContain("Invalid key revisions");
      }
      const linked = await t.strapi.db
        .query(REVISION)
        .findOne({ where: { id: revision.id }, populate: { page: { select: ["documentId"] } } });
      expect((linked?.page as { documentId?: string } | null)?.documentId).toBe(page.documentId);
    });

    it("a write response carries no revisions (PUT as admin_role with ?populate=revisions)", async () => {
      const res = await t.api<{ data: Record<string, unknown> }>(
        "admin_role",
        `/api/wiki-pages/${page.documentId}?populate=revisions&status=draft`,
        { method: "PUT", json: { data: { summary: "touched by the closure suite" } } },
      );
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty("revisions");
      expect(res.text).not.toContain(SECRET);
    });
  });

  describe("nothing else changes", () => {
    it("page reads: the web's queries answer as before", async () => {
      const bySlug =
        "/api/wiki-pages?filters[space][slug][$eq]=it-revisions-space&filters[slug][$eq]=it-revisions-page" +
        "&populate[author][fields][0]=displayName&populate[author][fields][1]=username" +
        "&populate[space][fields][0]=name&populate[space][fields][1]=slug";
      for (const role of TEST_ROLES) {
        const res = await t.api<{ data: Record<string, unknown>[] }>(role, bySlug);
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject({
          title: "IT Revisions Page",
          body: "ZZPUB-C second published version",
          space: { name: "IT Revisions Space", slug: "it-revisions-space" },
          author: { displayName: t.fixtures.users.member.displayName },
        });
      }
      const space = await t.api<{ data: { pages?: { title: string }[] }[] }>(
        "member",
        "/api/wiki-spaces?filters[slug][$eq]=it-revisions-space&populate[pages][fields][0]=title",
      );
      expect(space.status).toBe(200);
      expect(space.body.data[0]?.pages?.map((entry) => entry.title)).toEqual(["IT Revisions Page"]);
    });

    it("the moderators keep their draft reads of the page itself", async () => {
      for (const role of ["admin_role", "editor"] as const) {
        const res = await t.api<{ data: Record<string, unknown> }>(
          role,
          `/api/wiki-pages/${page.documentId}?status=draft`,
        );
        expect(res.status).toBe(200);
        expect(res.body.data.body).toBe("ZZDRAFT-E the current draft");
      }
    });

    it("an edit through the content API still writes its revision", async () => {
      const before = await t.strapi.db.query(REVISION).count();
      const res = await t.api("editor", `/api/wiki-pages/${page.documentId}?status=draft`, {
        method: "PUT",
        json: { data: { body: "ZZDRAFT-F the next draft", revisionSummary: "closure suite" } },
      });
      expect(res.status).toBe(200);
      expect(await t.strapi.db.query(REVISION).count()).toBe(before + 1);
      const written = await t.strapi.db
        .query(REVISION)
        .findOne({ where: { summary: "closure suite" }, populate: { editor: { select: ["id"] } } });
      expect(written).toMatchObject({
        body: "ZZDRAFT-E the current draft",
        editor: { id: t.fixtures.users.editor.id },
      });
      expect(written?.publishedAt).not.toBeNull();
    });
  });

  describe("the boot sync on a batch-15 database", () => {
    it("revokes exactly the 18 batch-15 grants and reports no drift", async () => {
      const roles = await t.strapi.db.query(ROLE).findMany({ select: ["id", "type"] });
      const roleId = new Map(roles.map((role) => [role.type as string, role.id]));
      let seeded = 0;
      for (const [type, actions] of Object.entries(BATCH_15_GRANTS)) {
        for (const action of actions) {
          await t.strapi.db.query(PERMISSION).create({
            data: { action: `${REVISION}.${action}`, role: roleId.get(type) },
          });
          seeded += 1;
        }
      }
      expect(seeded).toBe(18);

      const lines: string[] = [];
      const log = {
        info: (message: string) => lines.push(`info ${message}`),
        warn: (message: string) => lines.push(`warn ${message}`),
      };
      const host = t.strapi as unknown as Record<string, unknown>;
      const { syncRolePermissions } = t.requireBuilt<{
        syncRolePermissions(strapi: unknown): Promise<void>;
      }>("src/bootstrap/sync-permissions");
      await syncRolePermissions({ db: host.db, apis: host.apis, plugins: host.plugins, log });

      // The runbook's expected boot lines (docs/DEPLOYMENT.md, "Deploying
      // batch 15.1"): the five wiki-revision actions stay managed, now as
      // revocations, so the drift check still covers 142 actions.
      expect(lines).toEqual([
        "info [bootstrap] revoked 18 obsolete permission(s)",
        "info [bootstrap] permission drift: none (report-only check of 142 managed actions)",
      ]);
      expect(
        await t.strapi.db
          .query(PERMISSION)
          .count({ where: { action: { $startsWith: "api::wiki-revision." } } }),
      ).toBe(0);
    });
  });

  describe("the admin panel", () => {
    const ADMIN_PERMISSION = "admin::permission";
    const EXPLORER = "plugin::content-manager.explorer";

    it("the Content Manager lists no Wiki revision", () => {
      const contentTypes = t.strapi.plugin("content-manager").service("content-types") as {
        findDisplayedContentTypes(): { uid: string }[];
      };
      const displayed = contentTypes.findDisplayedContentTypes().map((type) => type.uid);
      expect(displayed).toContain(PAGE);
      expect(displayed).not.toContain(REVISION);
    });

    it("the boot's RBAC cleanup leaves the admin roles read-only on it", async () => {
      // A batch-15 database: an admin role (Strapi's own Editor role here)
      // may hold every Content Manager action on wiki revisions.
      const role = await t.strapi.db
        .query("admin::role")
        .findOne({ where: { code: "strapi-editor" } });
      if (!role) throw new Error("fixture: the admin Editor role is missing");
      const seeded = new Map<number, string>();
      for (const action of ["create", "read", "update", "delete", "publish"]) {
        const row = await t.strapi.db.query(ADMIN_PERMISSION).create({
          data: {
            action: `${EXPLORER}.${action}`,
            actionParameters: {},
            subject: REVISION,
            properties: { fields: ["page", "body", "summary", "editor"] },
            conditions: [],
            role: role.id,
          },
        });
        seeded.set(row.id, action);
      }
      const admin = (t.strapi as unknown as { admin: { services: Record<string, unknown> } }).admin;
      const permissions = admin.services.permission as {
        cleanPermissionsInDatabase(): Promise<void>;
      };
      await permissions.cleanPermissionsInDatabase();

      const left = await t.strapi.db
        .query(ADMIN_PERMISSION)
        .findMany({ where: { id: { $in: [...seeded.keys()] } } });
      expect(left.map((row) => seeded.get(row.id))).toEqual(["read"]);
    });
  });
});
