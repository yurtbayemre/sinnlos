import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_ENV, adminRequest, adminToken, contentManager } from "./admin-api.test.helper";
import {
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import { qualified } from "./pg-lock.test.helper";
import { minimalPdf, PNG_1PX, uploadFiles } from "./upload.test.helper";

/**
 * The delete trail (owner request 2026-10-13; batch 16 lane 16A) on SQLite
 * and Postgres 16: every ad delete and every upload-file delete writes one
 * audit_events row with who (user and role, admin, or system), from where
 * (content-api, admin, cron) and what (the ad's documentId and title; the
 * file's id, mime, size, related ad and name). One case per source:
 *   - ads: the author through the API, a moderator's takedown, the Content
 *     Manager, the nightly classified-janitor;
 *   - files: the ad delete's image cleanup, cleanup-uploads, the nightly
 *     uploads-janitor, the admin Media Library (single and bulk).
 */

const AD = "api::classified.classified";
const FILE = "plugin::upload.file";
const AUDIT = "api::audit-event.audit-event";

interface PurgeModule {
  purgeExpiredClassifieds(strapi: unknown, today?: unknown): Promise<number>;
}
interface SweepModule {
  sweepOrphanedUploads(strapi: unknown, now?: Date): Promise<void>;
}

describe.each(testEngines())("the delete trail on %s", (engine) => {
  let t: TestStrapi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** One admin login per boot: POST /admin/login is rate limited. */
  let adminJwt: string | undefined;
  const admin = async () => (adminJwt ??= await adminToken(t));

  const upload = async (role: TestRole, bytes: Uint8Array = PNG_1PX, name = "bike.png") => {
    const res = await uploadFiles(t, await t.loginAs(role), [{ name, bytes }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body[0] as { id: number; documentId: string };
  };

  const postAd = async (role: TestRole, title: string, images: number[] = []) => {
    const res = await t.api<{ data: { id: number; documentId: string } }>(
      role,
      "/api/classifieds",
      {
        json: { data: { title, description: "for sale", category: "sale", images } },
      },
    );
    expect(res.status, res.text).toBe(201);
    return res.body.data;
  };

  const auditRows = (where: Record<string, unknown>) =>
    t.strapi.db.query(AUDIT).findMany({ where: { action: "delete", ...where } }) as Promise<Row[]>;

  /** A file's rows, by its documentId (SQLite reuses a deleted row's id). */
  const fileRowsFor = (file: { documentId: string }) =>
    auditRows({ targetUid: FILE, targetDocumentId: file.documentId });

  it("the author deletes their ad: one ad row and one row per image, linked to the ad", async () => {
    const image = await upload("member");
    const ad = await postAd("member", "Red bike", [image.id]);
    const del = await t.api("member", `/api/classifieds/${ad.id}`, { method: "DELETE" });
    expect([200, 204], del.text).toContain(del.status);
    const [adRow] = await auditRows({ targetUid: AD, targetDocumentId: ad.documentId });
    expect(adRow).toMatchObject({
      actorKind: "user",
      actorUserId: t.fixtures.users.member.id,
      actorClass: "author",
      source: "content-api",
      detail: "role: member; title: Red bike",
    });
    await vi.waitFor(async () => expect(await fileRowsFor(image)).toHaveLength(1), {
      timeout: 5000,
    });
    const [fileRow] = await fileRowsFor(image);
    expect(fileRow).toMatchObject({
      targetDocumentId: image.documentId,
      actorKind: "user",
      actorUserId: t.fixtures.users.member.id,
      actorClass: "author",
      source: "content-api",
    });
    expect(String(fileRow.detail)).toMatch(
      new RegExp(
        `^role: member; file ${image.id}, image/png, \\d+ B, of ${AD} ${ad.documentId}: bike\\.png$`,
      ),
    );
    expect(JSON.stringify(fileRow)).not.toMatch(/127\.0\.0\.1|Bearer/);
  });

  it("a moderator's takedown is recorded with the moderator's role", async () => {
    const ad = await postAd("member", "Spam");
    const del = await t.api("editor", `/api/classifieds/${ad.id}`, { method: "DELETE" });
    expect([200, 204], del.text).toContain(del.status);
    const [row] = await auditRows({ targetUid: AD, targetDocumentId: ad.documentId });
    expect(row).toMatchObject({
      actorKind: "user",
      actorUserId: t.fixtures.users.editor.id,
      actorClass: "moderator",
      source: "content-api",
    });
  });

  it("a Content Manager delete is recorded as the admin, with its images", async () => {
    const image = await upload("member");
    const ad = await postAd("member", "Panel removed", [image.id]);
    const token = await admin();
    const panel = await contentManager(t, token);
    const del = await panel.delete(AD, ad.documentId);
    expect([200, 204], del.text).toContain(del.status);
    const [row] = await auditRows({ targetUid: AD, targetDocumentId: ad.documentId });
    expect(row).toMatchObject({ actorKind: "admin", source: "admin", actorUserId: null });
    expect(typeof row.actorAdminId).toBe("number");
    await vi.waitFor(async () => expect(await fileRowsFor(image)).toHaveLength(1), {
      timeout: 5000,
    });
    expect((await fileRowsFor(image))[0]).toMatchObject({ actorKind: "admin", source: "admin" });
  });

  it("the classified-janitor's purge is recorded as system, cron", async () => {
    const image = await upload("member");
    const ad = await postAd("member", "Long expired", [image.id]);
    await t.strapi.db.query(AD).update({ where: { id: ad.id }, data: { expiresAt: "2020-01-01" } });
    const { purgeExpiredClassifieds } = t.requireBuilt<PurgeModule>(
      "src/cron/purge-expired-classifieds",
    );
    expect(await purgeExpiredClassifieds(t.strapi)).toBeGreaterThanOrEqual(1);
    const [row] = await auditRows({ targetUid: AD, targetDocumentId: ad.documentId });
    expect(row).toMatchObject({
      actorKind: "system",
      source: "cron",
      detail: "title: Long expired",
    });
    await vi.waitFor(async () => expect(await fileRowsFor(image)).toHaveLength(1), {
      timeout: 5000,
    });
    expect((await fileRowsFor(image))[0]).toMatchObject({ actorKind: "system", source: "cron" });
  });

  it("cleanup-uploads records the caller's removal", async () => {
    const image = await upload("member");
    const res = await t.api<{ removed: number }>("member", "/api/classifieds/cleanup-uploads", {
      json: { imageIds: [image.id] },
    });
    expect(res.body).toEqual({ removed: 1 });
    const [row] = await fileRowsFor(image);
    expect(row).toMatchObject({
      actorKind: "user",
      actorUserId: t.fixtures.users.member.id,
      actorClass: "author",
      source: "content-api",
    });
  });

  it("the uploads-janitor records its sweep as system, cron (an editor's stale document upload)", async () => {
    const pdf = await upload("editor", minimalPdf(), "draft.pdf");
    const kept = await upload("editor", minimalPdf(), "kept.pdf");
    const table = engine === "postgres" ? qualified(t, "files") : "files";
    const old =
      engine === "postgres" ? "now() - interval '2 days'" : `${Date.now() - 2 * 86_400_000}`;
    await t.database.sql(`UPDATE ${table} SET created_at = ${old} WHERE id = ?`, [pdf.id]);
    const { sweepOrphanedUploads } = t.requireBuilt<SweepModule>("src/cron/sweep-orphaned-uploads");
    await sweepOrphanedUploads(t.strapi);
    expect(await t.strapi.db.query(FILE).findOne({ where: { id: pdf.id } })).toBeNull();
    expect(await t.strapi.db.query(FILE).findOne({ where: { id: kept.id } })).not.toBeNull();
    const [row] = await fileRowsFor(pdf);
    expect(row).toMatchObject({ actorKind: "system", source: "cron" });
    expect(String(row.detail)).toMatch(/application\/pdf, \d+ B: draft\.pdf$/);
  });

  it("overlapping Media Library deletes of one file record it once", async () => {
    const token = await admin();
    const file = await upload("member");
    const results = await Promise.all([
      adminRequest(t, token, `/upload/files/${file.id}`, { method: "DELETE" }),
      adminRequest(t, token, `/upload/files/${file.id}`, { method: "DELETE" }),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(await t.strapi.db.query(FILE).findOne({ where: { id: file.id } })).toBeNull();
    expect(await fileRowsFor(file)).toHaveLength(1);
  });

  it("the admin Media Library: a single and a bulk delete, each file recorded", async () => {
    const token = await admin();
    const [one, two, three] = [
      await upload("editor", minimalPdf(), "a.pdf"),
      await upload("member"),
      await upload("member"),
    ];
    const single = await adminRequest(t, token, `/upload/files/${one.id}`, { method: "DELETE" });
    expect(single.status, single.text).toBe(200);
    const bulk = await adminRequest(t, token, "/upload/actions/bulk-delete", {
      json: { fileIds: [two.id, three.id], folderIds: [] },
    });
    expect(bulk.status, bulk.text).toBe(200);
    for (const file of [one, two, three]) {
      const rows = await fileRowsFor(file);
      expect(rows, String(file.id)).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorKind: "admin",
        source: "admin",
        targetDocumentId: file.documentId,
      });
    }
  });
});
