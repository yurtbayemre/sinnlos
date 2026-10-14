import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createUser, signIn } from "./admin-api.test.helper";
import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";
import { minimalPdf, minimalXlsx, uploadFiles } from "./upload.test.helper";

/**
 * The documents gate (deep-dive decision 06 §A, §E2; batch 15 lane 15A,
 * `file` since batch 16 lane 16B) on SQLite and Postgres 16: documents are
 * written through the v2 write model by both classes. A NEW file must be
 * the caller's own upload that nothing else links (`ownUpload`), so no class
 * can link a file someone else uploaded (the takeover of S3.4); the stored
 * file of a panel-made document stays as it is on every web save.
 */
const D = "api::document.document";
const P = "documents";

describe.each(testEngines())("authoring documents (the write model) on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** A file row as the upload service stores one (no upload route in this batch). */
  const fileRow = async (uploadedBy: number) =>
    t.strapi.db.query("plugin::upload.file").create({
      data: {
        name: "policy.pdf",
        hash: `policy_${Math.random().toString(36).slice(2)}`,
        ext: ".pdf",
        mime: "application/pdf",
        size: 12.5,
        url: "/uploads/policy.pdf",
        provider: "local",
        provider_metadata: { uploadedBy },
      },
    });

  it("a moderator creates and publishes a document with category and departments, no file", async () => {
    const res = await api.create(
      "editor",
      P,
      {
        title: "Travel policy",
        description: "How to book",
        category: "policy",
        departments: [t.fixtures.departments.engineering.documentId],
      },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "published",
      publishAt: null,
      unpublishAt: null,
    });
    const [row] = await t.strapi.db.query(D).findMany({
      where: { documentId: res.body.data.documentId },
      populate: { uploadedBy: { select: ["id"] } },
    });
    expect((row.uploadedBy as { id: number }).id).toBe(t.fixtures.users.editor.id);
    expect(row.audience).toBe("departments");
  });

  it("attaches the caller's own fresh upload; refuses a foreign or taken one (batch 16)", async () => {
    const own = await fileRow(t.fixtures.users.editor.id);
    const foreign = await fileRow(t.fixtures.users.member.id);
    const res = await api.create("editor", P, { title: "With file", file: own.id }, "draft");
    expect(res.status, res.text).toBe(201);
    for (const file of [foreign.id, { id: own.id }]) {
      const refused = await api.create("editor", P, { title: "Refused file", file }, "draft");
      expect(refused.status, JSON.stringify(file)).toBe(400);
      expect(refused.body.error?.details).toEqual({ keys: ["file"] });
    }
    const head = await api.create(
      "department_head",
      P,
      { title: "Head file", file: (await fileRow(t.fixtures.users.editor.id)).id },
      "draft",
    );
    expect(head.status).toBe(400);
    expect(head.body.error?.details).toEqual({ keys: ["file"] });
    expect(
      await t.strapi.db
        .query(D)
        .count({ where: { title: { $in: ["Refused file", "Head file"] } } }),
    ).toBe(0);
  });

  it("keeps a panel-made document's file across web saves, and the form shows it read-only", async () => {
    const file = await fileRow(t.fixtures.users.admin_role.id);
    const doc = await t.strapi.documents(D).create({
      data: { title: "Panel doc", file: file.id },
      status: "published",
    });
    const form = await api.editable<{ version: string; file: Record<string, unknown> | null }>(
      "editor",
      P,
      doc.documentId,
    );
    expect(form.body.data.file).toMatchObject({
      id: file.id,
      name: "policy.pdf",
      mime: "application/pdf",
    });
    const save = await api.update(
      "editor",
      P,
      doc.documentId,
      { title: "Panel doc (edited)" },
      { status: "published", version: form.body.data.version },
    );
    expect(save.status, save.text).toBe(200);
    const rows = await t.strapi.db.query(D).findMany({
      where: { documentId: doc.documentId },
      populate: { file: { select: ["id"] } },
    });
    for (const row of rows) expect((row.file as { id: number } | null)?.id).toBe(file.id);
  });

  it("a department author's document: pinned to their department, theirs only", async () => {
    const res = await api.create(
      "department_head",
      P,
      { title: "Eng handbook", category: "guide" },
      "draft",
    );
    expect(res.status, res.text).toBe(201);
    const id = res.body.data.documentId;
    const form = await api.editable<Record<string, unknown>>("department_head", P, id);
    expect(form.body.data).toMatchObject({
      roleClass: "departmentAuthor",
      departments: [t.fixtures.departments.engineering.documentId],
      ownerDepartment: { documentId: t.fixtures.departments.engineering.documentId },
    });
    expect(form.body.data).not.toHaveProperty("publishAt");
    const widen = await api.update(
      "department_head",
      P,
      id,
      { departments: [] },
      { version: res.body.data.version },
    );
    expect(widen.body.error?.details).toEqual({ keys: ["departments"] });
    const schedule = await api.update(
      "department_head",
      P,
      id,
      { unpublishAt: new Date(Date.now() + 3_600_000).toISOString() },
      { version: res.body.data.version },
    );
    expect(schedule.body.error?.details).toEqual({ keys: ["unpublishAt"] });
    const editorDoc = await api.create("editor", P, { title: "Editor doc" }, "draft");
    expect((await api.editable("department_head", P, editorDoc.body.data.documentId)).status).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// Documents with files through the content API (batch 16 lane 16B item 7;
// S3.4-S3.6, §N10 batch 16): the upload profile (16A), the allowlist's
// ownUpload, and the media claims in slot 7.

describe.each(testEngines())("authoring documents with files on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const FILE = "plugin::upload.file";

  /** A fresh upload of `jwt`'s user through POST /api/upload. */
  const upload = async (jwt: string, name: string, bytes: Uint8Array) => {
    const res = await uploadFiles(t, jwt, [{ name, bytes }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body[0] as { id: number; mime: string; ext: string };
  };
  const exists = async (fileId: number) =>
    (await t.strapi.db.query(FILE).count({ where: { id: fileId } })) > 0;
  const fileIdsOf = async (documentId: string) =>
    (
      (await t.strapi.db.query(D).findMany({
        where: { documentId },
        populate: { file: { select: ["id"] } },
        orderBy: { id: "asc" },
      })) as unknown as { file: { id: number } | null }[]
    ).map((row) => row.file?.id ?? null);

  it("S3.4-S3.6: a moderator attaches a PDF, replaces it, and the old stamped file is removed after the commit", async () => {
    const jwt = await t.loginAs("editor");
    const first = await upload(jwt, "policy.pdf", minimalPdf());
    const created = await api.create(
      "editor",
      P,
      { title: "IT Policy", file: first.id },
      "published",
    );
    expect(created.status, created.text).toBe(201);
    expect(await fileIdsOf(created.body.data.documentId)).toEqual([first.id, first.id]);
    const second = await upload(jwt, "policy-v2.pdf", minimalPdf());
    // A draft-only replace keeps the published file until the publish (S3.5).
    const draft = await api.update(
      "editor",
      P,
      created.body.data.documentId,
      { file: second.id },
      { status: "draft", version: created.body.data.version },
    );
    expect(draft.status, draft.text).toBe(200);
    expect(await fileIdsOf(created.body.data.documentId)).toEqual([second.id, first.id]);
    expect(await exists(first.id)).toBe(true);
    const published = await api.action(
      "editor",
      P,
      created.body.data.documentId,
      "publish",
      draft.body.data.version,
    );
    expect(published.status, published.text).toBe(200);
    await vi.waitFor(async () => expect(await exists(first.id)).toBe(false), { timeout: 5000 });
    expect(await exists(second.id)).toBe(true);
    // Delete removes the stamped file (S3.6).
    const removed = await api.remove(
      "editor",
      P,
      created.body.data.documentId,
      published.body.data.version,
    );
    expect(removed.status).toBe(204);
    await vi.waitFor(async () => expect(await exists(second.id)).toBe(false), { timeout: 5000 });
  });

  it("keeps another editor's file on a save; refuses attaching it anew", async () => {
    const theirs = await upload(await t.loginAs("admin_role"), "theirs.pdf", minimalPdf());
    const doc = await t.strapi.documents(D).create({
      data: { title: "IT Shared", file: theirs.id },
      status: "published",
    });
    const form = await api.editable<{ version: string }>("editor", P, doc.documentId);
    const save = await api.update(
      "editor",
      P,
      doc.documentId,
      { title: "IT Shared (edited)", file: theirs.id },
      { status: "published", version: form.body.data.version },
    );
    expect(save.status, save.text).toBe(200);
    expect(await fileIdsOf(doc.documentId)).toEqual([theirs.id, theirs.id]);
    const other = await upload(await t.loginAs("admin_role"), "other.pdf", minimalPdf());
    const refused = await api.create("editor", P, { title: "IT Foreign", file: other.id }, "draft");
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details).toEqual({ keys: ["file"] });
  });

  it("two documents attaching one fresh upload: one ends with invalid", async () => {
    const fresh = await upload(await t.loginAs("editor"), "race.pdf", minimalPdf());
    const results = await Promise.all(
      ["IT Race A", "IT Race B"].map((title) =>
        api.create("editor", P, { title, file: fresh.id }, "draft"),
      ),
    );
    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
    const refused = results.find((res) => res.status === 400);
    expect(refused?.body.error?.details).toEqual({ keys: ["file"] });
    const linked = await t.strapi.db.query(D).count({
      where: { title: { $in: ["IT Race A", "IT Race B"] }, file: { id: fresh.id } },
    });
    expect(linked).toBe(1);
  });

  it("§N10: a department author's document with an XLSX; a successor head replaces it; Sales cannot list it", async () => {
    const engineering = t.fixtures.departments.engineering;
    const sales = t.fixtures.departments.sales;
    const headJwt = await t.loginAs("department_head");
    const sheet = await upload(headJwt, "budget.xlsx", minimalXlsx());
    expect(sheet.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const created = await api.create(
      "department_head",
      P,
      { title: "IT Budget", category: "form", file: sheet.id },
      "published",
    );
    expect(created.status, created.text).toBe(201);
    const documentId = created.body.data.documentId;
    // An Engineering member lists it, a Sales member does not.
    const listed = async (jwt: string) =>
      (
        (await t.api<{ data: { documentId: string }[] }>(
          { jwt },
          `/api/documents?filters[documentId][$eq]=${documentId}`,
        )) as { body: { data: { documentId: string }[] } }
      ).body.data.length;
    expect(await listed(await t.loginAs("member"))).toBe(1);
    const salesMember = await createUser(t, "member", sales);
    expect(await listed(await signIn(t, salesMember))).toBe(0);
    // A second head of Engineering manages the department's items: replaces the file.
    const successor = await createUser(t, "department_head", engineering);
    const successorJwt = await signIn(t, successor);
    const replacement = await upload(successorJwt, "budget-v2.xlsx", minimalXlsx());
    const replaced = await t.api<{ data: { version: string } }>(
      { jwt: successorJwt },
      `/api/documents/${documentId}?status=published`,
      {
        method: "PUT",
        headers: { "If-Match": `"${created.body.data.version}"` },
        json: { data: { file: replacement.id } },
      },
    );
    expect(replaced.status, replaced.text).toBe(200);
    expect(await fileIdsOf(documentId)).toEqual([replacement.id, replacement.id]);
    await vi.waitFor(async () => expect(await exists(sheet.id)).toBe(false), { timeout: 5000 });
    // The successor cannot attach the first head's fresh upload.
    const theirs = await upload(headJwt, "theirs.xlsx", minimalXlsx());
    const refused = await t.api<{ error?: { details?: unknown } }>(
      { jwt: successorJwt },
      `/api/documents/${documentId}?status=draft`,
      {
        method: "PUT",
        headers: { "If-Match": `"${replaced.body.data.version}"` },
        json: { data: { file: theirs.id } },
      },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details).toEqual({ keys: ["file"] });
  });

  it("§N10: after the department's delete the document is moderators-only and the head loses it", async () => {
    const doomed = await t.strapi.documents("api::department.department").create({
      data: { name: `IT Doomed Docs ${Date.now()}`, slug: `it-doomed-docs-${Date.now()}` },
    });
    const head = await createUser(t, "department_head", doomed);
    const jwt = await signIn(t, head);
    const pdf = await upload(jwt, "doomed.pdf", minimalPdf());
    const created = await t.api<{ data: { documentId: string } }>(
      { jwt },
      "/api/documents?status=published",
      {
        json: { data: { title: "IT Doomed Doc", file: pdf.id } },
      },
    );
    expect(created.status, created.text).toBe(201);
    const documentId = created.body.data.documentId;
    await t.strapi
      .documents("api::department.department")
      .delete({ documentId: doomed.documentId });
    expect((await t.api({ jwt }, `/api/documents/${documentId}/editable`)).status).toBe(404);
    const memberRead = await t.api<{ data: unknown[] }>(
      "member",
      `/api/documents?filters[documentId][$eq]=${documentId}`,
    );
    expect(memberRead.body.data).toEqual([]);
    const list = await api.list<{ documentId: string; needsRetarget: boolean }>("editor", P);
    expect(list.body.data.find((row) => row.documentId === documentId)?.needsRetarget).toBe(true);
    // The file stays with the document.
    expect(await exists(pdf.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What members read (batch 16.1, issue #80): the web's /documents loader
// (apps/web/src/lib/api/documents.ts) asks for every document it may see,
// with the file, the departments and the uploader populated; the document
// visibility policy decides by the departments and the `audience` flag
// (utils/policy-factories.ts departmentScopedIds).

/** The web's list request, as lib/api/documents.ts builds it (page 1). */
const WEB_DOCUMENTS =
  "/api/documents?populate[file]=true&populate[departments]=true&populate[uploadedBy]=true" +
  "&sort[0]=updatedAt:desc&sort[1]=id:desc&pagination[page]=1&pagination[pageSize]=100";

interface Scheduler {
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<{ unpublished: string[] }>;
}

describe.each(testEngines())("documents members read on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let salesJwt: string;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
    salesJwt = await signIn(t, await createUser(t, "member", t.fixtures.departments.sales));
  });
  afterAll(async () => {
    await t?.stop();
  });

  type Listed = { documentId: string; file: { url: string } | null };
  /** The documentIds a caller's /documents page lists, with their file URLs. */
  const library = async (jwt: string) => {
    const res = await t.api<{ data: Listed[] }>({ jwt }, WEB_DOCUMENTS);
    expect(res.status, res.text).toBe(200);
    return new Map(res.body.data.map((doc) => [doc.documentId, doc.file?.url ?? null]));
  };

  /** An editor's /manage document: a fresh PDF, saved as a draft, then published. */
  const editorDocument = async (title: string, departments: string[]) => {
    const jwt = await t.loginAs("editor");
    const upload = await uploadFiles(t, jwt, [{ name: "handbook.pdf", bytes: minimalPdf() }]);
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const fileId = (upload.body as { id: number }[])[0].id;
    // The payload of the web's buildDocumentPayload on a create.
    const created = await api.create(
      "editor",
      P,
      { title, description: null, category: "other", departments, file: fileId },
      "draft",
    );
    expect(created.status, created.text).toBe(201);
    const published = await api.action(
      "editor",
      P,
      created.body.data.documentId,
      "publish",
      created.body.data.version,
    );
    expect(published.status, published.text).toBe(200);
    return { documentId: created.body.data.documentId, version: published.body.data.version };
  };

  it("a document published to everyone (no department) is listed for every member, with its file", async () => {
    const memberJwt = await t.loginAs("member");
    const { documentId } = await editorDocument("[Test] Dokument", []);
    const rows = await t.strapi.db.query(D).findMany({
      where: { documentId },
      populate: { departments: { select: ["id"] } },
    });
    expect(rows.map((row) => [row.audience, (row.departments as unknown[]).length])).toEqual([
      ["all", 0],
      ["all", 0],
    ]);
    for (const jwt of [memberJwt, salesJwt]) {
      expect((await library(jwt)).get(documentId)).toMatch(/^\/uploads\//);
    }
  });

  it("a document from before the audience flag (NULL, no department) is listed for every member", async () => {
    const legacy = await t.strapi.documents(D).create({
      data: { title: "IT Legacy handbook" },
      status: "published",
    });
    await t.strapi.db.query(D).update({
      where: { documentId: legacy.documentId, publishedAt: { $notNull: true } },
      data: { audience: null },
    });
    const stored = await t.strapi.db.query(D).findOne({
      where: { documentId: legacy.documentId, publishedAt: { $notNull: true } },
    });
    expect(stored?.audience).toBeNull();
    for (const jwt of [await t.loginAs("member"), salesJwt]) {
      expect((await library(jwt)).has(legacy.documentId)).toBe(true);
    }
  });

  it("a Sales-only document is listed for Sales members only", async () => {
    const { documentId } = await editorDocument("IT Sales only", [
      t.fixtures.departments.sales.documentId,
    ]);
    expect((await library(salesJwt)).has(documentId)).toBe(true);
    expect((await library(await t.loginAs("member"))).has(documentId)).toBe(false);
  });

  it("a scheduled withdrawal takes it out of the library until it is published again; a draft save does not", async () => {
    const memberJwt = await t.loginAs("member");
    const doc = await editorDocument("IT Withdrawn", []);
    const scheduled = await api.update(
      "editor",
      P,
      doc.documentId,
      { unpublishAt: new Date(Date.now() + 120_000).toISOString() },
      { status: "published", version: doc.version },
    );
    expect(scheduled.status, scheduled.text).toBe(200);
    const scheduler = t.requireBuilt<Scheduler>("src/cron/scheduled-publish");
    const run = await scheduler.runScheduledPublishing(t.strapi, new Date(Date.now() + 300_000));
    expect(run.unpublished.join(" ")).toContain(doc.documentId);
    expect((await library(memberJwt)).has(doc.documentId)).toBe(false);
    // The form now shows a draft; saving it as one (the walkthrough's file
    // replace after the withdrawal) keeps it out of the library.
    const form = await api.editable<{ status: string; publishedAt: string | null }>(
      "editor",
      P,
      doc.documentId,
    );
    expect(form.body.data).toMatchObject({ status: "draft", publishedAt: null });
    const saved = await api.update(
      "editor",
      P,
      doc.documentId,
      { title: "IT Withdrawn (edited)" },
      { status: "draft", version: form.body.data.version },
    );
    expect(saved.status, saved.text).toBe(200);
    expect((await library(memberJwt)).has(doc.documentId)).toBe(false);
    const republished = await api.action(
      "editor",
      P,
      doc.documentId,
      "publish",
      saved.body.data.version,
    );
    expect(republished.status, republished.text).toBe(200);
    expect((await library(memberJwt)).has(doc.documentId)).toBe(true);
  });
});
