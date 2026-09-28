import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Params,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * What a caller can READ, over real HTTP against the real policies,
 * sanitizers and guards:
 *   - `?status=draft` on every draft & publish type answers with the
 *     published version only (FX06, §5.24), for every role without the
 *     admin_role/editor bypass; the bypass keeps draft reads;
 *   - relation side channels into hidden wiki pages are cut on every route
 *     (FX05): populate, filters, sort, nested populate and write responses;
 *   - contact fields are neither readable nor usable as a filter, sort or
 *     `_q` for guest and the `authenticated` fallback, and stay both for
 *     staff (issue #10 output sanitizer, FX22 sensitive-query-guard).
 */

/** Markers in the text field of each fixture document. */
const PUB = "ZZPUB";
const DRAFT = "ZZDRAFT";

interface DpType {
  uid: string;
  plural: string;
  /** The field that carries the marker. */
  field: string;
  /** Whether guest holds `find` on the type (the permission matrix). */
  guestReads: boolean;
  /** Required data, with `label` in `field`. */
  data(label: string, slug: string): Params;
}

type Dependencies = { space: Row; page: Row; course: Row };

function draftAndPublishTypes(deps: Dependencies): DpType[] {
  return [
    {
      uid: "api::announcement.announcement",
      plural: "announcements",
      field: "title",
      guestReads: false,
      data: (label) => ({ title: label, audience: "all" }),
    },
    {
      uid: "api::course.course",
      plural: "courses",
      field: "title",
      guestReads: false,
      data: (label, slug) => ({ title: label, slug }),
    },
    {
      uid: "api::document.document",
      plural: "documents",
      field: "title",
      guestReads: true,
      data: (label) => ({ title: label }),
    },
    {
      uid: "api::event.event",
      plural: "events",
      field: "title",
      guestReads: true,
      data: (label) => ({ title: label, start: "2026-10-05T08:00:00.000Z" }),
    },
    {
      uid: "api::lesson.lesson",
      plural: "lessons",
      field: "title",
      guestReads: false,
      data: (label) => ({ title: label, course: deps.course.documentId }),
    },
    {
      uid: "api::poll.poll",
      plural: "polls",
      field: "question",
      guestReads: true,
      data: (label) => ({ question: label, options: ["yes", "no"], visibleToGuests: true }),
    },
    {
      uid: "api::quick-link.quick-link",
      plural: "quick-links",
      field: "label",
      guestReads: true,
      data: (label) => ({ label, url: "https://intranet.invalid/link" }),
    },
    {
      uid: "api::wiki-page.wiki-page",
      plural: "wiki-pages",
      field: "title",
      guestReads: true,
      data: (label, slug) => ({ title: label, slug, space: deps.space.documentId }),
    },
    {
      uid: "api::wiki-revision.wiki-revision",
      plural: "wiki-revisions",
      field: "summary",
      guestReads: false,
      data: (label) => ({ summary: label, page: deps.page.documentId }),
    },
    {
      uid: "api::wiki-space.wiki-space",
      plural: "wiki-spaces",
      field: "name",
      guestReads: true,
      data: (label, slug) => ({ name: label, slug, visibility: "public" }),
    },
  ];
}

/** Every draft & publish type in the cms, from the loaded schemas. */
function draftAndPublishUids(t: TestStrapi): string[] {
  return Object.entries(t.strapi.contentTypes)
    .filter(([uid, schema]) => uid.startsWith("api::") && schema.options?.draftAndPublish === true)
    .map(([uid]) => uid)
    .sort();
}

const NO_BYPASS: readonly TestRole[] = ["department_head", "team_lead", "member", "authenticated"];

describe.each(testEngines())("read exposure on %s", (engine) => {
  let t: TestStrapi;
  let types: DpType[];
  const fixtures = new Map<string, { published: Row; draftOnly: Row }>();

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const docs = (uid: string) => t.strapi.documents(uid);
    const space = await docs("api::wiki-space.wiki-space").create({
      data: { name: "IT Public Space", slug: "it-public-space", visibility: "public" },
      status: "published",
    });
    const page = await docs("api::wiki-page.wiki-page").create({
      data: { title: "IT Revision Anchor", slug: "it-revision-anchor", space: space.documentId },
      status: "published",
    });
    const course = await docs("api::course.course").create({
      data: { title: "IT Course", slug: "it-course" },
      status: "published",
    });
    types = draftAndPublishTypes({ space, page, course });

    for (const type of types) {
      const name = type.plural;
      // Published, then a newer draft with other content.
      const published = await docs(type.uid).create({
        data: type.data(`${PUB}-${name}`, `zz-pub-${name}`),
        status: "published",
      });
      await docs(type.uid).update({
        documentId: published.documentId,
        data: { [type.field]: `${DRAFT}-${name}` },
      });
      // Never published.
      const draftOnly = await docs(type.uid).create({
        data: type.data(`${DRAFT}ONLY-${name}`, `zz-draft-only-${name}`),
      });
      fixtures.set(type.uid, { published, draftOnly });
    }
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe("?status=draft on every draft & publish type returns the published version only", () => {
    it("covers every draft & publish type of the cms", () => {
      expect(types.map((type) => type.uid).sort()).toEqual(draftAndPublishUids(t));
    });

    it.each(NO_BYPASS.flatMap((role) => ["list", "findOne"].map((kind) => [role, kind] as const)))(
      "%s, %s",
      async (role, kind) => {
        for (const type of types) {
          const { published, draftOnly } = fixtures.get(type.uid) as {
            published: Row;
            draftOnly: Row;
          };
          if (kind === "list") {
            const res = await t.api<{ data: Record<string, unknown>[] }>(
              role,
              `/api/${type.plural}?status=draft&pagination[pageSize]=100`,
            );
            expect({ type: type.plural, status: res.status }).toEqual({
              type: type.plural,
              status: 200,
            });
            expect(res.body.data.map((row) => row[type.field])).toContain(`${PUB}-${type.plural}`);
            expect({ type: type.plural, leaksDraft: res.text.includes(DRAFT) }).toEqual({
              type: type.plural,
              leaksDraft: false,
            });
          } else {
            const one = await t.api<{ data: Record<string, unknown> }>(
              role,
              `/api/${type.plural}/${published.documentId}?status=draft`,
            );
            expect({ type: type.plural, status: one.status }).toEqual({
              type: type.plural,
              status: 200,
            });
            expect(one.body.data[type.field]).toBe(`${PUB}-${type.plural}`);
            const hidden = await t.api(
              role,
              `/api/${type.plural}/${draftOnly.documentId}?status=draft`,
            );
            expect({ type: type.plural, status: hidden.status }).toEqual({
              type: type.plural,
              status: 404,
            });
          }
        }
      },
    );

    it("guest, on the types it reads (403 on the others)", async () => {
      for (const type of types) {
        const res = await t.api<{ data: Record<string, unknown>[] }>(
          "guest",
          `/api/${type.plural}?status=draft&pagination[pageSize]=100`,
        );
        if (!type.guestReads) {
          expect({ type: type.plural, status: res.status }).toEqual({
            type: type.plural,
            status: 403,
          });
          continue;
        }
        expect({ type: type.plural, status: res.status }).toEqual({
          type: type.plural,
          status: 200,
        });
        expect(res.body.data.map((row) => row[type.field])).toContain(`${PUB}-${type.plural}`);
        expect({ type: type.plural, leaksDraft: res.text.includes(DRAFT) }).toEqual({
          type: type.plural,
          leaksDraft: false,
        });
      }
    });

    it.each(["admin_role", "editor"] as const)(
      "%s keeps draft reads (authoring bypass)",
      async (role) => {
        for (const type of types) {
          const res = await t.api<{ data: Record<string, unknown>[] }>(
            role,
            `/api/${type.plural}?status=draft&pagination[pageSize]=100`,
          );
          expect({ type: type.plural, status: res.status }).toEqual({
            type: type.plural,
            status: 200,
          });
          const values = res.body.data.map((row) => row[type.field]);
          expect(values).toContain(`${DRAFT}-${type.plural}`);
          expect(values).toContain(`${DRAFT}ONLY-${type.plural}`);
        }
      },
    );
  });

  describe("relation side channels into hidden wiki pages (FX05)", () => {
    const MARKER = "ZZHIDDENPAGE";
    let hiddenSpace: Row;

    beforeAll(async () => {
      // A space only IT Sales may read, holding a page that names the
      // Engineering department and the Platform team: reachable as
      // department.pages / team.pages from rows the caller DOES see.
      hiddenSpace = await t.strapi.documents("api::wiki-space.wiki-space").create({
        data: {
          name: "IT Sales Only",
          slug: "it-sales-only",
          visibility: "department",
          department: t.fixtures.departments.sales.documentId,
        },
        status: "published",
      });
      await t.strapi.documents("api::wiki-page.wiki-page").create({
        data: {
          title: `${MARKER} salary bands`,
          slug: "zz-hidden-page",
          body: `${MARKER} body`,
          space: hiddenSpace.documentId,
          department: t.fixtures.departments.engineering.documentId,
          team: t.fixtures.teams.platform.documentId,
        },
        status: "published",
      });
    });

    it("the page itself is hidden from an Engineering member", async () => {
      const res = await t.api("member", `/api/wiki-pages?pagination[pageSize]=100`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(MARKER);
    });

    const probes: ReadonlyArray<readonly [string, string]> = [
      ["departments ?populate[pages]", "/api/departments?populate[pages]=true"],
      ["departments ?populate=*", "/api/departments?populate=*"],
      [
        "department findOne, nested",
        "/api/departments/{engineering}?populate[pages][populate][space]=true",
      ],
      ["teams ?populate[pages]", "/api/teams?populate[pages]=true"],
      ["users/me via department", "/api/users/me?populate[department][populate][pages]=true"],
      ["users via teams", "/api/users?populate[teams][populate][pages]=true"],
      ["wiki-spaces via department", "/api/wiki-spaces?populate[department][populate][pages]=true"],
      ["teams via department, dotted", "/api/teams?populate=department.pages"],
    ];

    const resolvePath = (path: string) =>
      path.replace("{engineering}", t.fixtures.departments.engineering.documentId);

    it.each(probes)("populate is cut for the non-bypass roles: %s", async (_label, path) => {
      for (const role of NO_BYPASS) {
        const res = await t.api(role, resolvePath(path));
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        expect({ role, leaks: res.text.includes(MARKER) }).toEqual({ role, leaks: false });
        expect({ role, pagesKey: /"pages"\s*:/.test(res.text) }).toEqual({ role, pagesKey: false });
      }
    });

    it("admin_role and editor keep the relation", async () => {
      for (const role of ["admin_role", "editor"] as const) {
        const res = await t.api(role, "/api/departments?populate[pages]=true");
        expect(res.status).toBe(200);
        expect(res.text).toContain(MARKER);
      }
    });

    it.each([
      ["filter", `/api/departments?filters[pages][title][$contains]=${MARKER}`],
      ["filter in $or", `/api/teams?filters[$or][0][pages][body][$startsWith]=${MARKER}`],
      ["sort", "/api/teams?sort=pages.title:asc"],
      [
        "filter nested in populate",
        `/api/departments?populate[teams][filters][pages][title][$lt]=M`,
      ],
    ])("a %s through the relation is refused with 400 (blind oracle)", async (_label, path) => {
      for (const role of NO_BYPASS) {
        const res = await t.api(role, path);
        expect({ role, status: res.status }).toEqual({ role, status: 400 });
      }
      expect((await t.api("admin_role", path)).status).toBe(200);
    });

    it("a write response does not populate the relation either (PUT /api/teams as its lead)", async () => {
      const res = await t.api<{ data: Record<string, unknown> }>(
        "team_lead",
        `/api/teams/${t.fixtures.teams.platform.documentId}?populate[pages]=true`,
        { method: "PUT", json: { data: { description: "Updated by the lead" } } },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe("Updated by the lead");
      expect(res.body.data).not.toHaveProperty("pages");
      expect(res.text).not.toContain(MARKER);
    });
  });

  describe("contact fields: output sanitizer and sensitive-query-guard", () => {
    const CONTACT = ["email", "phone", "officeLocation"] as const;

    it("guest and authenticated read users without contact fields; staff read them", async () => {
      const target = t.fixtures.users.editor;
      for (const role of ["guest", "authenticated"] as const) {
        const res = await t.api<Record<string, unknown>>(role, `/api/users/${target.id}`);
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
        for (const field of CONTACT) expect(res.body).not.toHaveProperty(field);
        expect(res.body.displayName).toBe(target.displayName);
      }
      for (const role of ["member", "admin_role"] as const) {
        const res = await t.api<Record<string, unknown>>(role, `/api/users/${target.id}`);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(target.email);
        expect(res.body.phone).toEqual(expect.any(String));
      }
    });

    const probes: ReadonlyArray<readonly [string, string]> = [
      ["filter on email", "/api/users?filters[email][$startsWith]=it-"],
      ["filter on phone, nested", "/api/users?filters[$and][0][phone][$notNull]=true"],
      ["sort on hireDate", "/api/users?sort=hireDate:asc"],
      ["_q full-text on users", "/api/users?_q=integration.test"],
      ["filter through a user relation", "/api/wiki-pages?filters[author][email][$contains]=it-"],
      [
        "filter in a populate",
        "/api/wiki-pages?populate[author][filters][officeLocation][$eq]=Lab",
      ],
    ];

    it.each(probes)("%s: 400 for guest and authenticated, 200 for staff", async (_label, path) => {
      for (const role of ["guest", "authenticated"] as const) {
        const res = await t.api(role, path);
        expect({ role, status: res.status }).toEqual({ role, status: 400 });
        expect(res.text).toContain("Invalid key");
      }
      for (const role of ["member", "team_lead", "editor", "admin_role"] as const) {
        const res = await t.api(role, path);
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
      }
    });

    it("staff filters really select by the contact field", async () => {
      const res = await t.api<Record<string, unknown>[]>(
        "member",
        `/api/users?filters[email][$eq]=${encodeURIComponent(t.fixtures.users.guest.email)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.map((user) => user.username)).toEqual([t.fixtures.users.guest.username]);
    });
  });
});
