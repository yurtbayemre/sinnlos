import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * The documents gate (deep-dive decision 06 §A, §E2; batch 15 lane 15A) on
 * SQLite and Postgres 16: documents are written through the v2 write model
 * by both classes, WITHOUT `file` (uploads, the document profile and the
 * file claims are batch 16; the attribute-coverage pin refuses it with that
 * reason). A file id answers the generic 400 for every class, so no class
 * can link a file someone else uploaded (the takeover of S3.4); the stored
 * file of a panel-made document stays as it is on every web save.
 */
const D = "api::document.document";
const P = "documents";

describe.each(testEngines())("authoring documents (gate) on %s", (engine) => {
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

  it("refuses a file id for every class, own upload or not (batch 16)", async () => {
    const own = await fileRow(t.fixtures.users.editor.id);
    const foreign = await fileRow(t.fixtures.users.member.id);
    for (const file of [own.id, foreign.id, { id: own.id }]) {
      const res = await api.create("editor", P, { title: "With file", file }, "draft");
      expect(res.status, JSON.stringify(file)).toBe(400);
      expect(res.body.error?.details).toEqual({ keys: ["file"] });
    }
    const head = await api.create(
      "department_head",
      P,
      { title: "Head file", file: own.id },
      "draft",
    );
    expect(head.status).toBe(400);
    expect(head.body.error?.details).toEqual({ keys: ["file"] });
    expect(
      await t.strapi.db.query(D).count({ where: { title: { $in: ["With file", "Head file"] } } }),
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
