import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ADMIN_ENV, adminToken, contentManager } from "./admin-api.test.helper";
import {
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import { authoringApi } from "./authoring.test.helper";
import { holdTransaction, qualified, settle, waitForLockWait } from "./pg-lock.test.helper";
import { minimalPdf, PNG_1PX, uploadFiles } from "./upload.test.helper";

/**
 * File claims and the one locked removal (deep-dive decision 06 §E3-§E5;
 * batch 16 plan items 3 and 4, contract K12) on SQLite and Postgres 16.
 *
 * The claims run in slot 7 of bootstrap/document-middlewares.ts (wired by
 * lane 16B), inside the transaction the document lock (slot 2) opened.
 * Attachments here go through the Document Service (as the scheduler and
 * boot writers do) and the Content Manager; a users-permissions caller is
 * simulated with `strapi.requestContext.run`. The content API's own path
 * (the allowlist's `ownUpload` plus the claims) is
 * authoring-documents.integration.test.ts.
 *
 * Removals run after the commit; the suite waits for them.
 */

const D = "api::document.document";
const FILE = "plugin::upload.file";
const AUDIT = "api::audit-event.audit-event";

interface OrphansModule {
  claimAndRemove(
    strapi: unknown,
    fileId: number,
    options?: Record<string, unknown>,
  ): Promise<string>;
  reserveRemoval(strapi: unknown, fileId: number): Promise<{ file?: unknown }>;
  removeReserved(strapi: unknown, fileId: number): Promise<string>;
}

const DEPARTMENT = "api::department.department";

/** A settled promise's error (undefined for a success). */
const errorOf = (result: unknown): unknown => (result as { error?: unknown } | undefined)?.error;

describe.each(testEngines())("media claims on %s", (engine) => {
  let t: TestStrapi;
  let orphans: OrphansModule;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    orphans = t.requireBuilt<OrphansModule>("src/utils/upload-orphans");
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** One admin login per boot: POST /admin/login is rate limited. */
  let adminJwt: string | undefined;
  const admin = async () => (adminJwt ??= await adminToken(t));

  const docs = () => t.strapi.documents(D);

  /** A stamped upload through the real endpoint. */
  const upload = async (role: TestRole = "editor", bytes: Uint8Array = minimalPdf()) => {
    const res = await uploadFiles(t, await t.loginAs(role), [{ name: "file.pdf", bytes }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body[0].id as number;
  };

  /** An unstamped file, as the admin panel's media library stores one. */
  const panelFile = async () =>
    (
      await t.strapi.db.query(FILE).create({
        data: {
          name: "panel.pdf",
          hash: `panel_${Math.random().toString(36).slice(2)}`,
          ext: ".pdf",
          mime: "application/pdf",
          size: 1,
          url: "/uploads/panel.pdf",
          provider: "local",
          provider_metadata: null,
        },
      })
    ).id;

  /** Runs `fn` as a users-permissions request of `role` (the claims read the caller from it). */
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

  const exists = async (fileId: number) =>
    (await t.strapi.db.query(FILE).findOne({ where: { id: fileId } })) !== null;
  const waitGone = (fileId: number) =>
    vi.waitFor(async () => expect(await exists(fileId)).toBe(false), { timeout: 5000 });

  const create = (data: Record<string, unknown>, status: "draft" | "published" = "draft") =>
    docs().create({ data: { title: "Policy", ...data }, status }) as Promise<Row>;

  it("attaches the caller's own upload; a second document cannot take it", async () => {
    const file = await upload("editor");
    const first = await asUser("editor", () => create({ file }));
    const row = await docs().findOne({ documentId: first.documentId, populate: { file: true } });
    expect((row?.file as { id: number }).id).toBe(file);
    await expect(asUser("editor", () => create({ file }))).rejects.toMatchObject({
      name: "ValidationError",
      details: { keys: ["file"] },
    });
  });

  it("refuses another user's upload and a wrong mime for a users-permissions caller", async () => {
    const foreign = await upload("department_head");
    await expect(asUser("editor", () => create({ file: foreign }))).rejects.toMatchObject({
      details: { keys: ["file"] },
    });
  });

  it("refuses a stamped file another type links (an ad's image), and a tombstoned one", async () => {
    const image = await upload("member", PNG_1PX);
    const ad = await t.api<{ data: { id: number } }>("member", "/api/classifieds", {
      json: { data: { title: "Bike", description: "Red", category: "sale", images: [image] } },
    });
    expect(ad.status, ad.text).toBe(201);
    await expect(create({ file: image })).rejects.toMatchObject({ details: { keys: ["file"] } });
    const doomed = await upload("editor");
    await t.strapi.db.query(FILE).update({
      where: { id: doomed },
      data: {
        provider_metadata: {
          uploadedBy: t.fixtures.users.editor.id,
          removing: new Date().toISOString(),
        },
      },
    });
    await expect(create({ file: doomed })).rejects.toMatchObject({ details: { keys: ["file"] } });
  });

  it("never claims or removes an unstamped panel file", async () => {
    const file = await panelFile();
    const doc = await create({ file });
    await docs().update({ documentId: doc.documentId, data: { file: null } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await exists(file)).toBe(true);
  });

  it("removes the replaced file after an update, with its audit row linked to the document", async () => {
    const [oldFile, newFile] = [await upload(), await upload()];
    const doc = await create({ file: oldFile });
    await asUser("editor", () =>
      docs().update({ documentId: doc.documentId, data: { file: newFile } }),
    );
    await waitGone(oldFile);
    expect(await exists(newFile)).toBe(true);
    const rows = await t.strapi.db.query(AUDIT).findMany({ where: { targetUid: FILE } });
    const row = rows.find((r) => String(r.detail).includes(`file ${oldFile},`));
    expect(row).toMatchObject({
      action: "delete",
      actorKind: "user",
      actorUserId: t.fixtures.users.editor.id,
      // The editor removes their own upload: class author, the role in the detail.
      actorClass: "author",
    });
    expect(String(row?.detail)).toContain(`of ${D} ${doc.documentId}`);
    expect(String(row?.detail)).toMatch(/^role: editor; /);
  });

  it("a draft-only replace keeps the published file until the publish (S3.5)", async () => {
    const [published, replacement] = [await upload(), await upload()];
    const doc = await create({ file: published }, "published");
    await docs().update({
      documentId: doc.documentId,
      data: { file: replacement },
      status: "draft",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await exists(published)).toBe(true);
    await docs().publish({ documentId: doc.documentId });
    await waitGone(published);
    expect(await exists(replacement)).toBe(true);
  });

  it("unpublish releases the published file the draft no longer links; discard the draft's", async () => {
    const [published, draft] = [await upload(), await upload()];
    const doc = await create({ file: published }, "published");
    await docs().update({ documentId: doc.documentId, data: { file: draft }, status: "draft" });
    await docs().unpublish({ documentId: doc.documentId });
    await waitGone(published);
    expect(await exists(draft)).toBe(true);

    const [kept, discarded] = [await upload(), await upload()];
    const other = await create({ file: kept }, "published");
    await docs().update({
      documentId: other.documentId,
      data: { file: discarded },
      status: "draft",
    });
    await docs().discardDraft({ documentId: other.documentId });
    await waitGone(discarded);
    expect(await exists(kept)).toBe(true);
  });

  it("a delete removes the stamped file (S3.6)", async () => {
    const file = await upload();
    const doc = await create({ file }, "published");
    await docs().delete({ documentId: doc.documentId });
    await waitGone(file);
  });

  it("a Content Manager replace and publish removes the old stamped file", async () => {
    const panel = await contentManager(t, await admin());
    const [oldFile, newFile] = [await upload(), await upload()];
    const doc = await create({ file: oldFile }, "published");
    const saved = await panel.update(D, doc.documentId, { title: "Policy", file: newFile });
    expect(saved.status, saved.text).toBe(200);
    expect(await exists(oldFile)).toBe(true);
    const published = await panel.publish(D, doc.documentId, { title: "Policy", file: newFile });
    expect(published.status, published.text).toBe(200);
    await waitGone(oldFile);
    const rows = await t.strapi.db
      .query(AUDIT)
      .findMany({ where: { targetUid: FILE, actorKind: "admin" } });
    expect(rows.some((r) => String(r.detail).startsWith(`file ${oldFile},`))).toBe(true);
  });

  it("two attaches of one fresh upload: exactly one wins", async () => {
    const file = await upload();
    const results = await Promise.all([
      settle(asUser("editor", () => create({ file }))),
      settle(asUser("editor", () => create({ file }))),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(errorOf(refused)).toMatchObject({ details: { keys: ["file"] } });
  });

  it("a classified write refuses a tombstoned image from every source (API, Content Manager)", async () => {
    const image = await upload("member", PNG_1PX);
    await t.strapi.db.query(FILE).update({
      where: { id: image },
      data: {
        provider_metadata: {
          uploadedBy: t.fixtures.users.member.id,
          removing: new Date().toISOString(),
        },
      },
    });
    const api = await t.api("member", "/api/classifieds", {
      json: { data: { title: "Bike", description: "Red", category: "sale", images: [image] } },
    });
    expect(api.status, api.text).toBe(400);
    const panel = await contentManager(t, await admin());
    const created = await panel.create("api::classified.classified", {
      title: "Panel ad",
      description: "x",
      category: "sale",
      expiresAt: "2030-01-01",
      images: [image],
    });
    expect(created.status, created.text).toBe(400);
    // Strings that 5.57 coerced to the id are refused too (Codex round 3): by
    // our guard (details.keys) or, since Strapi 5.58, by Strapi's own relation
    // lookup ("Document with id ... not found"). Either way nothing is written.
    for (const ref of [` ${image}`, `+${image}`]) {
      await expect(
        t.strapi.documents("api::classified.classified").create({
          data: {
            title: "Coerced",
            description: "x",
            category: "sale",
            expiresAt: "2030-01-01",
            images: [ref],
          },
        }),
      ).rejects.toMatchObject({ name: "ValidationError" });
    }
    expect(
      await t.strapi.db.query("api::classified.classified").count({ where: { title: "Coerced" } }),
    ).toBe(0);
    const clean = await upload("member", PNG_1PX);
    const ok = await panel.create("api::classified.classified", {
      title: "Panel ad",
      description: "x",
      category: "sale",
      expiresAt: "2030-01-01",
      images: [clean],
    });
    expect(ok.status, ok.text).toBe(201);
  });

  it("a user avatar refuses a tombstoned file from the query layer and the Document Service; a clean one links", async () => {
    const USER = "plugin::users-permissions.user";
    const member = t.fixtures.users.member;
    const image = await upload("member", PNG_1PX);
    await t.strapi.db.query(FILE).update({
      where: { id: image },
      data: { provider_metadata: { uploadedBy: member.id, removing: new Date().toISOString() } },
    });
    await expect(
      t.strapi.db.query(USER).update({ where: { id: member.id }, data: { avatar: image } }),
    ).rejects.toMatchObject({ details: { keys: ["avatar"] } });
    const row = (await t.strapi.db.query(USER).findOne({ where: { id: member.id } })) as {
      documentId: string;
    };
    await expect(
      t.strapi
        .documents(USER)
        .update({ documentId: row.documentId, data: { avatar: image } as Record<string, unknown> }),
    ).rejects.toMatchObject({ details: { keys: ["avatar"] } });
    const clean = await upload("member", PNG_1PX);
    await t.strapi.db.query(USER).update({ where: { id: member.id }, data: { avatar: clean } });
    const linked = (await t.strapi.db
      .query(USER)
      .findOne({ where: { id: member.id }, populate: { avatar: true } })) as unknown as {
      avatar: { id: number } | null;
    };
    expect(linked.avatar?.id).toBe(clean);
  });

  it("publish and clone do not copy a tombstoned file (a removal that failed after its reservation)", async () => {
    const file = await upload();
    const doc = await create({ file });
    await t.strapi.db.query(FILE).update({
      where: { id: file },
      data: {
        provider_metadata: {
          uploadedBy: t.fixtures.users.editor.id,
          removing: new Date().toISOString(),
        },
      },
    });
    await expect(docs().publish({ documentId: doc.documentId })).rejects.toMatchObject({
      details: { keys: ["file"] },
    });
    const panel = await contentManager(t, await admin());
    const clone = await panel.clone(D, doc.documentId, { title: "Copy" });
    expect(clone.status, clone.text).toBe(400);
    // Replacing the file is how the document gets out of it.
    const fresh = await upload();
    await docs().update({ documentId: doc.documentId, data: { file: fresh } });
    await docs().publish({ documentId: doc.documentId });
  });

  it("Save and publish replaces a tombstoned file (an update with status published)", async () => {
    const file = await upload();
    const doc = await create({ file }, "published");
    await t.strapi.db.query(FILE).update({
      where: { id: file },
      data: {
        provider_metadata: {
          uploadedBy: t.fixtures.users.editor.id,
          removing: new Date().toISOString(),
        },
      },
    });
    // A disconnect of another file keeps the tombstoned one: still refused.
    await expect(
      docs().update({
        documentId: doc.documentId,
        data: { file: { disconnect: [{ id: file + 100000 }] } },
        status: "published",
      }),
    ).rejects.toMatchObject({ details: { keys: ["file"] } });
    const fresh = await upload();
    await docs().update({ documentId: doc.documentId, data: { file: fresh }, status: "published" });
    const published = await docs().findOne({
      documentId: doc.documentId,
      status: "published",
      populate: { file: true },
    });
    expect((published?.file as { id: number }).id).toBe(fresh);
  });

  it("org image attachment and the user avatar refuse a reserved file; the removal then completes", async () => {
    const file = await upload("admin_role", PNG_1PX);
    expect((await orphans.reserveRemoval(t.strapi, file)).file).toBeDefined();
    await expect(
      t.strapi.documents(DEPARTMENT).update({
        documentId: t.fixtures.departments.sales.documentId,
        data: { headerImage: file },
      }),
    ).rejects.toMatchObject({ details: { keys: ["headerImage"] } });
    // The unclaimed avatar used to link it, and the removal then left it as
    // "linked" with its tombstone; the generic guard (v0.17.9) refuses it too.
    const user = t.fixtures.users.member.id;
    await expect(
      t.strapi.db
        .query("plugin::users-permissions.user")
        .update({ where: { id: user }, data: { avatar: file } }),
    ).rejects.toMatchObject({ details: { keys: ["avatar"] } });
    expect(await orphans.removeReserved(t.strapi, file)).toBe("removed");
    expect(await exists(file)).toBe(false);
  });

  it.each([
    ["api::course.course", "courses", "coverImage"],
    [DEPARTMENT, "departments", "headerImage"],
    ["api::team.team", "teams", "avatar"],
  ])(
    "%s: HTTP image ownership, type, retain, replacement and clearing",
    async (uid, plural, field) => {
      const api = authoringApi(t);
      const training = plural === "courses";
      const target = await t.strapi.documents(uid).create({
        data: training
          ? { title: "Media course", slug: `media-course-${Math.random().toString(36).slice(2)}` }
          : {
              name: `Media ${Math.random().toString(36).slice(2)}`,
              slug: `media-${Math.random().toString(36).slice(2)}`,
            },
        ...(training ? { status: "published" } : {}),
      });
      const save = async (data: Record<string, unknown>, role: TestRole = "admin_role") => {
        const form = await api.editable(role, plural, target.documentId);
        return api.update(role, plural, target.documentId, data, {
          version: form.body.data?.version,
          status: training ? "published" : null,
        });
      };
      const own = await upload("admin_role", PNG_1PX);
      const foreign = await upload("editor", PNG_1PX);
      const pdf = await upload("admin_role");
      expect((await save({ [field]: foreign })).status).toBe(400);
      expect((await save({ [field]: pdf })).status).toBe(400);
      const attached = await save({ [field]: own });
      expect(attached.status, attached.text).toBe(200);
      const form = await api.editable("admin_role", plural, target.documentId);
      expect(form.body.data[field]).toMatchObject({ id: own, mime: "image/png" });
      // Keeping another author's existing file is not a fresh attachment.
      if (training) expect((await save({ [field]: own }, "editor")).status).toBe(200);
      else expect((await save({ [field]: foreign }, "editor")).status).toBe(403);
      await expect(
        asUser("admin_role", () =>
          t.strapi.documents(uid).create({
            data: training
              ? {
                  title: "Taken",
                  slug: `taken-${Math.random().toString(36).slice(2)}`,
                  [field]: own,
                }
              : {
                  name: `Taken ${Math.random()}`,
                  slug: `taken-${Math.random().toString(36).slice(2)}`,
                  [field]: own,
                },
          }),
        ),
      ).rejects.toMatchObject({ details: { keys: [field] } });
      const replacement = await upload("admin_role", PNG_1PX);
      expect((await save({ [field]: replacement })).status).toBe(200);
      await waitGone(own);
      expect((await save({ [field]: null })).status).toBe(200);
      await waitGone(replacement);

      const legacy = await panelFile();
      await t.strapi.documents(uid).update({
        documentId: target.documentId,
        data: { [field]: legacy },
        ...(training ? { status: "published" } : {}),
      });
      expect((await save({ [field]: legacy })).status).toBe(200);
      expect((await save({ [field]: null })).status).toBe(200);
      expect(await exists(legacy)).toBe(true);
    },
  );

  it("course draft replacement retains the published image until publish, and rollback keeps links/files", async () => {
    const uid = "api::course.course";
    const first = await upload("editor", PNG_1PX);
    const second = await upload("editor", PNG_1PX);
    const parent = await asUser("editor", () =>
      t.strapi.documents(uid).create({
        data: { title: "Image drafts", slug: "image-drafts", coverImage: first },
        status: "published",
      }),
    );
    await expect(
      t.strapi.db.transaction(async () => {
        await asUser("editor", () =>
          t.strapi.documents(uid).update({
            documentId: parent.documentId,
            status: "published",
            data: { coverImage: second },
          }),
        );
        throw new Error("rollback image replacement");
      }),
    ).rejects.toThrow("rollback image replacement");
    expect(await exists(first)).toBe(true);
    await asUser("editor", () =>
      t.strapi
        .documents(uid)
        .update({ documentId: parent.documentId, status: "draft", data: { coverImage: second } }),
    );
    expect(await exists(first)).toBe(true);
    const published = await t.strapi.documents(uid).findOne({
      documentId: parent.documentId,
      status: "published",
      populate: { coverImage: true },
    });
    expect(published?.coverImage).toMatchObject({ id: first });
    await t.strapi.documents(uid).publish({ documentId: parent.documentId });
    await waitGone(first);
    expect(await exists(second)).toBe(true);
  });

  it("attaches by the file's documentId too; a tombstoned one is refused before any link", async () => {
    const res = await uploadFiles(t, await t.loginAs("editor"), [
      { name: "a.pdf", bytes: minimalPdf() },
    ]);
    const { id, documentId } = res.body[0] as { id: number; documentId: string };
    const doc = await asUser("editor", () => create({ file: { documentId } }));
    const row = await docs().findOne({ documentId: doc.documentId, populate: { file: true } });
    expect((row?.file as { id: number }).id).toBe(id);
    const doomed = await uploadFiles(t, await t.loginAs("editor"), [
      { name: "b.pdf", bytes: minimalPdf() },
    ]);
    const target = doomed.body[0] as { id: number; documentId: string };
    await t.strapi.db.query(FILE).update({
      where: { id: target.id },
      data: {
        provider_metadata: {
          uploadedBy: t.fixtures.users.editor.id,
          removing: new Date().toISOString(),
        },
      },
    });
    await expect(
      asUser("editor", () => create({ file: { set: [{ documentId: target.documentId }] } })),
    ).rejects.toMatchObject({ details: { keys: ["file"] } });
  });

  describe.runIf(engine === "postgres")("races under the file row's lock (Postgres)", () => {
    const makeOld = (fileId: number) =>
      t.database.sql(
        `UPDATE ${qualified(t, "files")} SET created_at = now() - interval '2 days' WHERE id = ?`,
        [fileId],
      );

    /** Holds the file row, starts `first` then `second`, releases: they run in that order. */
    async function race<A, B>(fileId: number, first: () => Promise<A>, second: () => Promise<B>) {
      const held = await holdTransaction(t);
      await held.raw(`SELECT id FROM ${qualified(t, "files")} WHERE id = ? FOR UPDATE`, [fileId]);
      const a = settle(first());
      await waitForLockWait(t);
      const b = settle(second());
      await new Promise((resolve) => setTimeout(resolve, 300));
      await held.commit();
      return Promise.all([a, b]);
    }

    it("a link in flight when a reserved removal starts: the removal waits for it and keeps the file", async () => {
      const file = await upload();
      await orphans.reserveRemoval(t.strapi, file);
      const department = await t.strapi.db
        .query(DEPARTMENT)
        .findOne({ where: { documentId: t.fixtures.departments.sales.documentId } });
      // A writer that checks no tombstone, mid-transaction: its link's
      // foreign key holds FOR KEY SHARE on the file row.
      const held = await holdTransaction(t);
      await held.raw(
        `INSERT INTO ${qualified(t, "files_related_mph")} (file_id, related_id, related_type, field, "order") VALUES (?, ?, ?, 'headerImage', 1)`,
        [file, department?.id, DEPARTMENT],
      );
      const removal = settle(orphans.removeReserved(t.strapi, file));
      await waitForLockWait(t);
      await held.commit();
      expect(await removal).toMatchObject({ ok: true, value: "linked" });
      expect(await exists(file)).toBe(true);
      await t.database.sql(`DELETE FROM ${qualified(t, "files_related_mph")} WHERE file_id = ?`, [
        file,
      ]);
    });

    it("two concurrent attaches by documentId: one wins, the other fails invalid (no 40P01)", async () => {
      const res = await uploadFiles(t, await t.loginAs("editor"), [
        { name: "c.pdf", bytes: minimalPdf() },
      ]);
      const { documentId } = res.body[0] as { documentId: string };
      const results = await Promise.all([
        settle(asUser("editor", () => create({ file: { documentId } }))),
        settle(asUser("editor", () => create({ file: { documentId } }))),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(errorOf(results.find((r) => !r.ok))).toMatchObject({ details: { keys: ["file"] } });
    });

    it("the janitor against an attach: the form keeps the file or fails invalid, never a dangling link", async () => {
      for (const order of ["attach first", "janitor first"] as const) {
        const file = await upload();
        await makeOld(file);
        const attach = () => create({ file });
        const janitor = () =>
          orphans.claimAndRemove(t.strapi, file, { minAgeMs: 24 * 3600 * 1000 });
        const [attachResult, janitorResult] =
          order === "attach first"
            ? await race(file, attach, janitor)
            : (await race(file, janitor, attach)).reverse();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stillThere = await exists(file);
        if (attachResult.ok) {
          expect(stillThere, order).toBe(true);
          expect(janitorResult).toMatchObject({ ok: true, value: "linked" });
        } else {
          expect(stillThere, order).toBe(false);
          expect(errorOf(attachResult), order).toMatchObject({ details: { keys: ["file"] } });
        }
        expect(order === "attach first" ? attachResult.ok : !attachResult.ok, order).toBe(true);
      }
    });

    it("org attachment and cleanup serialize on the same file lock", async () => {
      for (const attachFirst of [true, false]) {
        const file = await upload("admin_role", PNG_1PX);
        const target = await t.strapi.documents(DEPARTMENT).create({
          data: {
            name: `Race ${Math.random()}`,
            slug: `race-${Math.random().toString(36).slice(2)}`,
          },
        });
        const attach = () =>
          asUser("admin_role", () =>
            t.strapi
              .documents(DEPARTMENT)
              .update({ documentId: target.documentId, data: { headerImage: file } }),
          );
        const remove = () => orphans.claimAndRemove(t.strapi, file);
        const [attachment, removal] = attachFirst
          ? await race(file, attach, remove)
          : (await race(file, remove, attach)).reverse();
        expect(attachment.ok).toBe(attachFirst);
        expect(await exists(file)).toBe(attachFirst);
        if (attachFirst) expect(removal).toMatchObject({ ok: true, value: "linked" });
        else expect(errorOf(attachment)).toMatchObject({ details: { keys: ["headerImage"] } });
      }
    });

    it("cleanup-uploads against a document attach: kept and linked, or removed and refused", async () => {
      for (const order of ["attach first", "cleanup first"] as const) {
        const file = await upload("editor");
        const jwt = await t.loginAs("editor");
        const attach = () => create({ file });
        const cleanup = () =>
          fetch(`${t.baseUrl}/api/classifieds/cleanup-uploads`, {
            method: "POST",
            headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
            body: JSON.stringify({ imageIds: [file] }),
          }).then(async (res) => (await res.json()) as { removed: number });
        const [attachResult, cleanupResult] =
          order === "attach first"
            ? await race(file, attach, cleanup)
            : (await race(file, cleanup, attach)).reverse();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const stillThere = await exists(file);
        if (attachResult.ok) {
          expect(stillThere, order).toBe(true);
          expect(cleanupResult).toMatchObject({ ok: true, value: { removed: 0 } });
        } else {
          expect(stillThere, order).toBe(false);
          expect(cleanupResult).toMatchObject({ ok: true, value: { removed: 1 } });
        }
        expect(order === "attach first" ? attachResult.ok : !attachResult.ok, order).toBe(true);
      }
    });
  });
});
