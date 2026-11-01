import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import { storedRevision } from "./authoring.test.helper";
import { testSchema } from "./pg-lock.test.helper";
import { WIKI_PAGE, seedPage, seedSpace, wikiApi, type WikiApi } from "./wiki.test.helper";

/**
 * Who may open an uploaded file (v0.34, audit finding B1;
 * utils/upload-access.ts, utils/upload-reference-guard.ts), over real HTTP
 * against the running cms: POST /api/auth/uploads/access as the web's
 * /uploads proxy asks it, and the write check on Markdown references.
 *
 * Fixtures: staff in "IT Engineering", the guest and the `authenticated`
 * fallback without a department, nobody in "IT Sales". team_lead must set
 * up a second factor here (MFA_REQUIRED_ROLES), so its password session is
 * restricted.
 */

const TOKEN = "integration-upload-access-token";
const FILE = "plugin::upload.file";
const DOCUMENT = "api::document.document";
const ANNOUNCEMENT = "api::announcement.announcement";
const REVISION = "api::wiki-revision.wiki-revision";
const USER = "plugin::users-permissions.user";
const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const EVENT = "api::event.event";
const CLASSIFIED = "api::classified.classified";

interface StoredFile {
  id: number;
  name: string;
}

describe.each(testEngines())("upload access on %s", (engine) => {
  let t: TestStrapi;
  let wiki: WikiApi;
  let space: Row & { documentId: string };
  beforeAll(async () => {
    t = await createTestStrapi({
      engine,
      env: { INTERNAL_UPLOAD_TOKEN: TOKEN, MFA_REQUIRED_ROLES: "team_lead" },
    });
    wiki = wikiApi(t);
    space = await seedSpace(t, { name: "IT Upload Space" });
  });
  afterAll(async () => {
    await t?.stop();
  });

  const sales = () => t.fixtures.departments.sales.documentId as string;
  const engineering = () => t.fixtures.departments.engineering.documentId as string;

  let serial = 0;
  /** A file row as the admin panel (no stamp) or the hardened upload (stamp) stores one. */
  const storeFile = async (
    options: { stampedBy?: number; formats?: Record<string, { url: string }> } = {},
  ): Promise<StoredFile> => {
    const hash = `ua_${++serial}_${Math.random().toString(16).slice(2, 10)}`;
    const row = (await t.strapi.db.query(FILE).create({
      data: {
        name: `${hash}.png`,
        hash,
        ext: ".png",
        mime: "image/png",
        size: 1,
        url: `/uploads/${hash}.png`,
        provider: "local",
        provider_metadata: options.stampedBy ? { uploadedBy: options.stampedBy } : null,
        formats: options.formats ?? null,
      },
    })) as Row;
    return { id: row.id as number, name: `${hash}.png` };
  };

  const access = (caller: Caller, name: unknown, token: string | null = TOKEN) =>
    t.api<{ data?: { allow: boolean } }>(caller, "/api/auth/uploads/access", {
      json: { name },
      headers: token ? { "x-internal-token": token } : {},
    });

  const allows = async (caller: TestRole, name: string) => {
    const res = await access(caller, name);
    expect(res.status, `${caller} ${name}: ${res.text}`).toBe(200);
    return res.body.data?.allow;
  };

  /** Who of `roles` may open `name`. */
  const openers = async (name: string, roles: TestRole[]) => {
    const open: TestRole[] = [];
    for (const role of roles) if (await allows(role, name)) open.push(role);
    return open;
  };

  const document = (data: Record<string, unknown>) =>
    t.strapi.documents(DOCUMENT).create({
      data: { title: `IT doc ${++serial}`, ...data },
      status: "published",
    }) as Promise<Row & { documentId: string }>;

  const ref = (file: StoredFile) => `![image](/uploads/${file.name})`;

  /** The refusal codes of a 400. */
  const refusal = (res: { status: number; body: unknown; text: string }) => {
    expect(res.status, res.text).toBe(400);
    return (res.body as { error?: { details?: { codes?: Record<string, string> } } }).error?.details
      ?.codes;
  };

  it("answers only the web server, and only a signed-in, unrestricted account", async () => {
    const file = await storeFile();
    expect((await access("member", file.name, null)).status).toBe(404);
    expect((await access("member", file.name, "wrong")).status).toBe(404);
    expect([401, 403]).toContain((await access(null, file.name)).status);
    // A restricted session (second factor not set up) reads nothing.
    expect((await access("team_lead", file.name)).status).toBe(403);
    expect((await access("member", "")).status).toBe(400);
    expect((await access("member", 42)).status).toBe(400);
    expect(await allows("member", "never_uploaded_000000.png")).toBe(false);
  });

  it("a department-only document's file opens for its audience and moderators only", async () => {
    const file = await storeFile();
    const doc = await document({
      audience: "departments",
      departments: [sales()],
      ownerDepartment: sales(),
      file: file.id,
    });
    const roles: TestRole[] = ["admin_role", "editor", "department_head", "member", "guest"];
    expect(await openers(file.name, roles)).toEqual(["admin_role", "editor"]);

    await t.strapi.documents(DOCUMENT).update({
      documentId: doc.documentId,
      data: { departments: [engineering()], ownerDepartment: engineering() },
      status: "published",
    });
    expect(await openers(file.name, roles)).toEqual([
      "admin_role",
      "editor",
      "department_head",
      "member",
    ]);

    // Unpublished: only the draft links it, which only its authors open.
    await t.strapi.documents(DOCUMENT).unpublish({ documentId: doc.documentId });
    expect(await openers(file.name, roles)).toEqual(["admin_role", "editor", "department_head"]);
  });

  it("a company-wide document's file opens for guests too; renditions only by the stored formats", async () => {
    const file = await storeFile({
      formats: { thumbnail: { url: "/uploads/thumbnail_placeholder.png" } },
    });
    await t.strapi.db.query(FILE).update({
      where: { id: file.id },
      data: { formats: { thumbnail: { url: `/uploads/thumbnail_${file.name}` } } },
    });
    await document({ audience: "all", file: file.id });
    expect(await allows("guest", file.name)).toBe(true);
    expect(await allows("guest", `thumbnail_${file.name}`)).toBe(true);
    expect(await allows("guest", `small_${file.name}`)).toBe(false);
    expect(await allows("guest", "thumbnail_placeholder.png")).toBe(false);
  });

  it("each version opens by its own rule: a published file for the audience, a draft file for its authors", async () => {
    const published = await storeFile();
    const draft = await storeFile();
    const doc = await document({
      audience: "departments",
      departments: [engineering()],
      ownerDepartment: engineering(),
      file: published.id,
    });
    await t.strapi.documents(DOCUMENT).update({
      documentId: doc.documentId,
      data: { file: draft.id },
      status: "draft",
    });
    expect(await allows("member", published.name)).toBe(true);
    expect(await allows("member", draft.name)).toBe(false);
    expect(await allows("department_head", draft.name)).toBe(true);
    expect(await allows("guest", published.name)).toBe(false);
  });

  it("an admin-panel file nothing links opens through a readable Markdown text that names it", async () => {
    const forEngineering = await storeFile();
    const forSales = await storeFile();
    const everywhere = await storeFile();
    const neverPublished = await storeFile();
    const announcement = (data: Record<string, unknown>, status: "draft" | "published") =>
      t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: `IT announcement ${++serial}`, ...data },
        status,
      });
    await announcement(
      { audience: "departments", department: engineering(), body: ref(forEngineering) },
      "published",
    );
    await announcement(
      { audience: "departments", department: sales(), body: `${ref(forSales)} ${ref(everywhere)}` },
      "published",
    );
    await announcement({ audience: "all", body: ref(neverPublished) }, "draft");
    await seedPage(t, { space: space.documentId, body: `See ${ref(everywhere)}.` });

    expect(await openers(forEngineering.name, ["member", "guest", "authenticated"])).toEqual([
      "member",
    ]);
    expect(await allows("member", forSales.name)).toBe(false);
    // One file, hosts with different audiences: the readable one decides.
    expect(await openers(everywhere.name, ["member", "guest"])).toEqual(["member", "guest"]);
    expect(await allows("member", neverPublished.name)).toBe(false);
  });

  it("a linked file ignores inline references, until its last link is gone", async () => {
    const file = await storeFile();
    const doc = await document({
      audience: "departments",
      departments: [sales()],
      ownerDepartment: sales(),
      file: file.id,
    });
    await seedPage(t, { space: space.documentId, body: ref(file) });
    expect(await allows("member", file.name)).toBe(false);
    await t.strapi.documents(DOCUMENT).delete({ documentId: doc.documentId });
    expect(await t.strapi.db.query(FILE).findOne({ where: { id: file.id } })).not.toBeNull();
    expect(await allows("member", file.name)).toBe(true);
  });

  it("a stamped file nothing links opens for its uploader only, inline references or not", async () => {
    const file = await storeFile({ stampedBy: t.fixtures.users.member.id });
    await seedPage(t, { space: space.documentId, body: ref(file) });
    expect(await openers(file.name, ["member", "department_head", "guest"])).toEqual(["member"]);
  });

  it("avatars follow the directory: active people for every role, blocked people for moderators", async () => {
    const userService = t.strapi.plugin("users-permissions").service("user") as {
      add(values: Record<string, unknown>): Promise<Row>;
    };
    const roles = t.strapi.db.query("plugin::users-permissions.role");
    const member = await roles.findOne({ where: { type: "member" } });
    const person = async (blocked: boolean) => {
      const avatar = await storeFile();
      const suffix = `${++serial}`;
      await userService.add({
        username: `it-avatar-${suffix}`,
        email: `it-avatar-${suffix}@integration.test`,
        displayName: `Avatar ${suffix}`,
        provider: "local",
        password: "Avatar-Password-2026!",
        confirmed: true,
        blocked,
        role: member?.id,
        avatar: avatar.id,
      });
      return avatar;
    };
    const active = await person(false);
    const blocked = await person(true);
    expect(await openers(active.name, ["member", "guest"])).toEqual(["member", "guest"]);
    expect(await openers(blocked.name, ["editor", "member", "guest"])).toEqual(["editor"]);
    const stored = await t.strapi.db
      .query(USER)
      .findOne({ where: { email: `it-avatar-${serial}@integration.test` }, populate: ["avatar"] });
    expect((stored as { avatar?: { id: number } } | null)?.avatar?.id).toBe(blocked.id);
  });

  it("an image only in a wiki revision opens for whoever may read the page's history", async () => {
    const file = await storeFile();
    const page = await seedPage(t, {
      space: space.documentId,
      body: "now without the image",
      author: t.fixtures.users.member.documentId,
    });
    await t.strapi.db.query(REVISION).create({
      data: { pageDocumentId: page.documentId, body: ref(file), kind: "after" },
    });
    expect(await openers(file.name, ["editor", "member", "guest"])).toEqual(["editor", "member"]);
  });

  it("every Markdown host counts, by the audience its pages apply", async () => {
    const [lessonFile, courseFile, departmentFile, teamFile, eventFile, expiredFile] =
      await Promise.all(Array.from({ length: 6 }, () => storeFile()));
    const course = await t.strapi.documents(COURSE).create({
      data: {
        title: `IT course ${++serial}`,
        slug: `it-course-${serial}`,
        description: ref(courseFile),
      },
      status: "published",
    });
    await t.strapi.documents(LESSON).create({
      data: {
        title: `IT lesson ${serial}`,
        body: ref(lessonFile),
        order: 0,
        course: course.documentId,
      },
      status: "published",
    });
    await t.strapi.documents(DEPARTMENT).update({
      documentId: engineering(),
      data: { description: ref(departmentFile) },
    });
    await t.strapi.documents(TEAM).update({
      documentId: t.fixtures.teams.platform.documentId as string,
      data: { description: ref(teamFile) },
    });
    await t.strapi.documents(EVENT).create({
      data: {
        title: `IT event ${serial}`,
        start: "2030-01-10T10:00:00.000Z",
        description: ref(eventFile),
      },
      status: "published",
    });
    await t.strapi.documents(ANNOUNCEMENT).create({
      data: {
        title: `IT expired ${serial}`,
        audience: "all",
        body: ref(expiredFile),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      status: "published",
    });
    // guest holds no course, lesson, department or team grant; event it does.
    for (const file of [lessonFile, courseFile, departmentFile, teamFile]) {
      expect(await openers(file.name, ["member", "guest"]), file.name).toEqual(["member"]);
    }
    expect(await openers(eventFile.name, ["member", "guest"])).toEqual(["member", "guest"]);
    // An expired announcement is gone for its readers, and so is its image.
    expect(await openers(expiredFile.name, ["editor", "member"])).toEqual(["editor"]);
  });

  it("ads, department headers and team avatars open through their own read grants", async () => {
    const [adImage, header, teamAvatar] = await Promise.all([
      storeFile(),
      storeFile(),
      storeFile(),
    ]);
    await t.strapi.documents(CLASSIFIED).create({
      data: {
        title: `IT ad ${++serial}`,
        description: "Red bike",
        category: "sale",
        expiresAt: "2030-01-01",
        author: t.fixtures.users.member.documentId,
        images: [adImage.id],
      },
    });
    await t.strapi.documents(DEPARTMENT).update({
      documentId: sales(),
      data: { headerImage: header.id },
    });
    await t.strapi.documents(TEAM).update({
      documentId: t.fixtures.teams.platform.documentId as string,
      data: { avatar: teamAvatar.id },
    });
    // guest holds no classified, department or team grant.
    for (const file of [adImage, header, teamAvatar]) {
      expect(await openers(file.name, ["member", "guest"]), file.name).toEqual(["member"]);
    }
  });

  it("a reference ends at a Unicode space, as the renderer links it", async () => {
    const file = await storeFile();
    await seedPage(t, { space: space.documentId, body: `/uploads/${file.name}\u00a0caption` });
    expect(await allows("member", file.name)).toBe(true);
  });

  it("a name one file's original and another file's rendition share", async () => {
    const common = await storeFile();
    const commonDoc = await document({ audience: "all", file: common.id });
    // Already in a readable text before the second file claims the name.
    await seedPage(t, { space: space.documentId, body: ref(common) });
    const hidden = await storeFile({ formats: { small: { url: `/uploads/${common.name}` } } });
    // The name means the original: the text does not open the claimant...
    expect(await allows("member", hidden.name)).toBe(false);
    // ...and a new reference must be openable for every claimant.
    const res = await wiki.createDraft("department_head", {
      title: `IT common ${++serial}`,
      body: ref(common),
      space: space.documentId,
    });
    expect(refusal(res)).toEqual({ body: "uploadNotAllowed" });
    // Once the original is gone the name means the claimant, and the text
    // written before opens it: the rollout inventory lists such rows
    // (means = false) for review.
    await t.strapi.documents(DOCUMENT).delete({ documentId: commonDoc.documentId });
    await t.strapi.db.query(FILE).delete({ where: { id: common.id } });
    expect(await allows("member", hidden.name)).toBe(true);
  });

  it("a linked file whose last link goes opens only through a readable text", async () => {
    const file = await storeFile();
    const doc = await document({
      audience: "departments",
      departments: [sales()],
      ownerDepartment: sales(),
      file: file.id,
    });
    await t.strapi.documents(ANNOUNCEMENT).create({
      data: {
        title: `IT sales ${++serial}`,
        audience: "departments",
        department: sales(),
        body: ref(file),
      },
      status: "published",
    });
    await t.strapi.documents(DOCUMENT).delete({ documentId: doc.documentId });
    expect(await allows("member", file.name)).toBe(false);
  });

  describe("the grants decide like the routes do", () => {
    const PERMISSION = "plugin::users-permissions.permission";
    /** Takes `action` from `role` while `fn` runs, then gives it back. */
    const without = async (role: TestRole, actions: string[], fn: () => Promise<void>) => {
      const roleRow = await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: role } });
      const permissions = t.strapi.db.query(PERMISSION);
      const removed: string[] = [];
      try {
        for (const action of actions) {
          const row = await permissions.findOne({ where: { action, role: roleRow?.id } });
          if (!row) continue;
          await permissions.delete({ where: { id: row.id } });
          removed.push(action);
        }
        await fn();
      } finally {
        for (const action of removed) {
          await permissions.create({ data: { action, role: roleRow?.id } });
        }
      }
    };

    it("a published row opens through any read action that shows it", async () => {
      const cover = await storeFile();
      await t.strapi.documents(COURSE).create({
        data: {
          title: `IT covered ${++serial}`,
          slug: `it-covered-${serial}`,
          coverImage: cover.id,
        },
        status: "published",
      });
      expect(await allows("member", cover.name)).toBe(true);
      await without("member", ["api::course.course.findOne"], async () => {
        expect(await allows("member", cover.name)).toBe(true);
      });
      await without(
        "member",
        ["api::course.course.find", "api::course.course.findOne"],
        async () => {
          expect(await allows("member", cover.name)).toBe(false);
        },
      );
    });

    it("a lesson's text opens through the player alone", async () => {
      const image = await storeFile();
      const course = await t.strapi.documents(COURSE).create({
        data: { title: `IT played ${++serial}`, slug: `it-played-${serial}` },
        status: "published",
      });
      await t.strapi.documents(LESSON).create({
        data: {
          title: `IT player ${serial}`,
          body: ref(image),
          order: 0,
          course: course.documentId,
        },
        status: "published",
      });
      const reads = ["api::lesson.lesson.find", "api::lesson.lesson.findOne"];
      await without("member", reads, async () => {
        expect(await allows("member", image.name)).toBe(true);
      });
      await without("member", [...reads, "api::lesson.lesson.player"], async () => {
        expect(await allows("member", image.name)).toBe(false);
      });
    });

    it("a draft needs the authoring grant, a revision the history grant", async () => {
      const draft = await storeFile();
      const doc = await document({
        audience: "departments",
        departments: [engineering()],
        ownerDepartment: engineering(),
      });
      await t.strapi.documents(DOCUMENT).update({
        documentId: doc.documentId,
        data: { file: draft.id },
        status: "draft",
      });
      expect(await allows("department_head", draft.name)).toBe(true);
      await without("department_head", ["api::document.document.editable"], async () => {
        expect(await allows("department_head", draft.name)).toBe(false);
      });

      const old = await storeFile();
      const page = await seedPage(t, {
        space: space.documentId,
        body: "current",
        author: t.fixtures.users.member.documentId,
      });
      await t.strapi.db.query(REVISION).create({
        data: { pageDocumentId: page.documentId, body: ref(old), kind: "after" },
      });
      expect(await allows("member", old.name)).toBe(true);
      await without("member", ["api::wiki-page.wiki-page.revision"], async () => {
        expect(await allows("member", old.name)).toBe(false);
      });
    });
  });

  it.runIf(engine === "postgres")(
    "infra/diagnostics/upload-references.sql runs read-only and lists the references",
    async () => {
      const { Client } = requireCmsDependency<{
        Client: new (config: { connectionString: string }) => {
          connect(): Promise<void>;
          query(sql: string): Promise<unknown>;
          end(): Promise<void>;
        };
      }>("pg");
      const panel = await storeFile();
      const stamped = await storeFile({ stampedBy: t.fixtures.users.member.id });
      const spaced = await storeFile();
      const shadow = await storeFile({ formats: { small: { url: `/uploads/${panel.name}` } } });
      const page = await seedPage(t, {
        space: space.documentId,
        body: `${ref(panel)} ${ref(stamped)} /uploads/gone_000000.png. /uploads/${spaced.name}\u00a0x`,
      });
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query(`SET search_path TO "${testSchema(t)}"`);
        const sql = readFileSync(
          join(__dirname, "..", "..", "..", "..", "infra", "diagnostics", "upload-references.sql"),
          "utf8",
        );
        const results = (await client.query(sql)) as Array<{
          command: string;
          rows: Array<Record<string, unknown>>;
        }>;
        expect(results[0].command).toBe("BEGIN");
        expect(results[results.length - 1].command).toBe("ROLLBACK");
        const [listing, summary] = results
          .filter((result) => result.command === "SELECT")
          .map((result) => result.rows);
        const ofPage = listing.filter((row) => row.document_id === page.documentId);
        expect(ofPage.map((row) => [row.section, row.file_name, row.status]).sort()).toEqual(
          // The page's draft and published rows, and the revision its
          // lifecycle recorded (listed under the page's documentId).
          [
            ["1 inline_unstamped", panel.name, "published"],
            ["1 inline_unstamped", panel.name, "draft"],
            ["1 inline_unstamped", panel.name, "history"],
            ["2 inline_stamped", stamped.name, "published"],
            ["2 inline_stamped", stamped.name, "draft"],
            ["2 inline_stamped", stamped.name, "history"],
            ["3 unresolvable", "gone_000000.png", "published"],
            ["3 unresolvable", "gone_000000.png", "draft"],
            ["3 unresolvable", "gone_000000.png", "history"],
            ["1 inline_unstamped", spaced.name, "published"],
            ["1 inline_unstamped", spaced.name, "draft"],
            ["1 inline_unstamped", spaced.name, "history"],
            ["1 inline_unstamped", shadow.name, "published"],
            ["1 inline_unstamped", shadow.name, "draft"],
            ["1 inline_unstamped", shadow.name, "history"],
          ].sort(),
        );
        // The claimant of the panel file's name is listed for review, but the
        // name means the panel file: the claimant opens for nobody yet.
        expect(
          ofPage.filter((row) => row.file_name === shadow.name).map((row) => row.means),
        ).toEqual([false, false, false]);
        expect(
          ofPage.filter((row) => row.file_name === panel.name).map((row) => row.means),
        ).toEqual([true, true, true]);
        const unused = listing
          .filter((row) => row.section === "4 unused_panel_files")
          .map((row) => row.file_id);
        expect(unused).toContain(shadow.id);
        expect(unused).not.toContain(panel.id);
        expect(unused).not.toContain(spaced.id);
        // The counts are the listing's, section by section (collision claimants included).
        const rows = (section: string) => listing.filter((row) => row.section === section).length;
        expect({
          inline_unstamped: Number(summary[0].inline_unstamped),
          inline_stamped: Number(summary[0].inline_stamped),
          unresolvable: Number(summary[0].unresolvable),
          unused_panel_files: Number(summary[0].unused_panel_files),
        }).toEqual({
          inline_unstamped: rows("1 inline_unstamped"),
          inline_stamped: rows("2 inline_stamped"),
          unresolvable: rows("3 unresolvable"),
          unused_panel_files: rows("4 unused_panel_files"),
        });
        expect(rows("1 inline_unstamped")).toBeGreaterThanOrEqual(6);
      } finally {
        await client.end();
      }
    },
  );

  describe("the write check on Markdown references", () => {
    let forbidden: StoredFile;
    let allowed: StoredFile;
    beforeAll(async () => {
      forbidden = await storeFile();
      await document({
        audience: "departments",
        departments: [sales()],
        ownerDepartment: sales(),
        file: forbidden.id,
      });
      allowed = await storeFile();
      await document({ audience: "all", file: allowed.id });
    });

    it("refuses a non-moderator's new reference to a file they may not open", async () => {
      const planted = await wiki.createDraft("department_head", {
        title: "IT planted",
        body: `Look: ${ref(forbidden)}`,
        space: space.documentId,
      });
      expect(refusal(planted)).toEqual({ body: "uploadNotAllowed" });

      const fine = await wiki.createDraft("department_head", {
        title: "IT fine",
        body: `${ref(allowed)} and /uploads/no_such_file.png`,
        space: space.documentId,
      });
      expect(fine.status, fine.text).toBe(201);
      const documentId = fine.body.data.documentId;

      const version = () => storedRevision(t, WIKI_PAGE, documentId);
      const later = await wiki.saveDraft(
        "department_head",
        documentId,
        { body: `${ref(allowed)} ${ref(forbidden)}` },
        await version(),
      );
      expect(refusal(later)).toEqual({ body: "uploadNotAllowed" });

      const kept = await wiki.saveDraft(
        "department_head",
        documentId,
        { body: `${ref(allowed)} edited` },
        await version(),
      );
      expect(kept.status, kept.text).toBe(200);
    });

    /** Runs `fn` as a content-API request of `role` (the guard reads the caller from it). */
    const asUser = <T>(role: TestRole, fn: () => Promise<T>): Promise<T> =>
      (
        t.strapi.requestContext as unknown as {
          run(ctx: unknown, cb: () => Promise<T>): Promise<T>;
        }
      ).run(
        {
          state: {
            auth: { strategy: { name: "users-permissions" } },
            user: { id: t.fixtures.users[role].id, role: { type: role } },
          },
          get: () => "",
        },
        fn,
      );

    it("checks every write of a Markdown field, not only the wiki's", async () => {
      const writes: Array<[string, string, () => Promise<unknown>]> = [
        [
          "announcement create",
          "body",
          () =>
            t.strapi.documents(ANNOUNCEMENT).create({
              data: { title: "IT planted", audience: "all", body: ref(forbidden) },
              status: "draft",
            }),
        ],
        [
          "department description",
          "description",
          () =>
            t.strapi.documents(DEPARTMENT).update({
              documentId: engineering(),
              data: { description: `Our team ${ref(forbidden)}` },
            }),
        ],
        [
          "event create",
          "description",
          () =>
            t.strapi.documents(EVENT).create({
              data: {
                title: "IT planted",
                start: "2030-01-10T10:00:00.000Z",
                description: ref(forbidden),
              },
              status: "draft",
            }),
        ],
      ];
      for (const [name, field, write] of writes) {
        await expect(asUser("department_head", write), name).rejects.toMatchObject({
          name: "ValidationError",
          details: { keys: [field], codes: { [field]: "uploadNotAllowed" } },
        });
      }
      // The same write without a caller (the admin panel, the scheduler) is not checked.
      await expect(writes[1]![2]()).resolves.toBeTruthy();
    });

    it("refuses a planted rendition with a custom format name", async () => {
      const original = await storeFile();
      const rendition = `extra_small_${original.name.replace(/\.png$/, ".webp")}`;
      await t.strapi.db.query(FILE).update({
        where: { id: original.id },
        data: { formats: { extra_small: { url: `/uploads/${rendition}` } } },
      });
      await document({
        audience: "departments",
        departments: [sales()],
        ownerDepartment: sales(),
        file: original.id,
      });
      const planted = await wiki.createDraft("department_head", {
        title: "IT rendition",
        body: `![x](/uploads/${rendition})`,
        space: space.documentId,
      });
      expect(refusal(planted)).toEqual({ body: "uploadNotAllowed" });
      expect(await allows("department_head", rendition)).toBe(false);
    });

    it("refuses a restore that brings back a file the writer may not open", async () => {
      const created = await wiki.createDraft("department_head", {
        title: `IT restore ${++serial}`,
        body: "first",
        space: space.documentId,
      });
      expect(created.status, created.text).toBe(201);
      const documentId = created.body.data.documentId;
      const revision = (await t.strapi.db.query(REVISION).create({
        data: { pageDocumentId: documentId, body: ref(forbidden), kind: "after", title: "old" },
      })) as Row;
      const page = (await t.strapi.db
        .query(WIKI_PAGE)
        .findOne({ where: { documentId, publishedAt: null } })) as Row;
      await t.strapi.db
        .query(REVISION)
        .update({ where: { id: revision.id }, data: { page: page.id } });
      const res = await wiki.restore(
        "department_head",
        documentId,
        revision.id as number,
        await storedRevision(t, WIKI_PAGE, documentId),
      );
      expect(refusal(res)).toEqual({ body: "uploadNotAllowed" });
    });

    it("lets moderators reference every file", async () => {
      const res = await wiki.createDraft("editor", {
        title: "IT editor link",
        body: ref(forbidden),
        space: space.documentId,
      });
      expect(res.status, res.text).toBe(201);
    });
  });
});
