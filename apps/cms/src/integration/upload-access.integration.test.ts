import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import { storedRevision } from "./authoring.test.helper";
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

    const refusal = (res: { status: number; body: unknown; text: string }) => {
      expect(res.status, res.text).toBe(400);
      return (res.body as { error?: { details?: { codes?: Record<string, string> } } }).error
        ?.details?.codes;
    };

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
