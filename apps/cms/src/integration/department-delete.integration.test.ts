import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";
import {
  holdTransaction,
  qualified,
  settle,
  waitForLockWait,
  type Settled,
} from "./pg-lock.test.helper";

/**
 * Deleting a department on the real stack (FX29 residual; owner answer
 * 2026-09-29 (b): RESTRICT, the poll pattern, the delete is not refused).
 *
 * The delete cascades the department's link rows away. Before this lane a
 * document or quick link targeted only at the deleted department was left
 * with no departments and read as company-wide: every member, guests
 * included, saw it. Now the department delete hook flags every row that
 * linked the department with audience 'departments' first
 * (utils/department-delete-restrict.ts), in the delete's transaction, and
 * the read policies keep a flagged row without departments for admin_role
 * and editor only, until a moderator re-targets it. A row that also links
 * a surviving department stays visible to that department. On Postgres the
 * hook locks the department rows before it reads their links, so a link
 * an edit commits while the delete runs is flagged too.
 *
 * Since the batch 12 review (B12-01) the flag is an invariant, as for
 * polls: the write-time guard (utils/department-audience-guard.ts) flags
 * every row a Document Service write links, and the boot backfill
 * (utils/department-audience-backfill.ts) the rows linked before it. So a
 * copy of a row taken before the delete carries the flag too: an admin
 * form saved afterwards (both engines), and on Postgres a publish or a
 * "Discard changes" that read the row before the delete committed and
 * recreates it afterwards (the last cases, which opened the row without
 * the guard).
 */

const TYPES = [
  { uid: "api::document.document", key: "document", path: "/api/documents", field: "title" },
  {
    uid: "api::quick-link.quick-link",
    key: "quick-link",
    path: "/api/quick-links",
    field: "label",
  },
] as const;

type ScopedType = (typeof TYPES)[number];

const DEPARTMENT = "api::department.department";

/** What else a quick link requires: its url. */
const required = (type: ScopedType) =>
  type.uid === "api::quick-link.quick-link" ? { url: "https://example.test" } : {};

describe.each(testEngines())("department delete on %s", (engine) => {
  let t: TestStrapi;
  let temp: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    temp = await t.strapi.documents("api::department.department").create({
      data: { name: "IT Temp", slug: "it-temp" },
    });
    const engineering = t.fixtures.departments.engineering.documentId;
    const sales = t.fixtures.departments.sales.documentId;
    for (const type of TYPES) {
      const create = (label: string, departments: string[]) =>
        t.strapi.documents(type.uid).create({
          data: {
            [type.field]: label,
            departments,
            ...required(type),
          },
          status: "published",
        });
      await create("IT only temp", [temp.documentId]);
      await create("IT temp and eng", [temp.documentId, engineering]);
      await create("IT company-wide", []);
      await create("IT sales", [sales]);
    }
  });

  afterAll(async () => {
    await t?.stop();
  });

  const labels = async (caller: Caller, type: ScopedType) => {
    const res = await t.api<{ data: Record<string, unknown>[] }>(
      caller,
      `${type.path}?pagination[pageSize]=100&filters[${type.field}][$startsWith]=IT `,
    );
    expect(res.status, `${String(caller)} ${type.path}`).toBe(200);
    return res.body.data.map((row) => String(row[type.field])).sort();
  };

  /** [label, published?, audience] of the rows whose label starts with `prefix`. */
  const audiences = async (type: ScopedType, prefix: string) => {
    const rows = await t.strapi.db.query(type.uid).findMany({
      where: { [type.field]: { $startsWith: prefix } },
      select: [type.field, "audience", "publishedAt"],
      orderBy: [{ [type.field]: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => [row[type.field], row.publishedAt != null, row.audience]);
  };

  it("before the delete, the temp-only rows are for nobody outside the department", async () => {
    for (const type of TYPES) {
      expect(await labels("member", type), type.path).toEqual([
        "IT company-wide",
        "IT temp and eng",
      ]);
      expect(await labels("guest", type), type.path).toEqual(["IT company-wide"]);
      // The write-time guard (B12-01): every row that links a department,
      // draft and published, carries the flag from its create on, although
      // the create left Audience at its default 'all'.
      expect(await audiences(type, "IT "), type.path).toEqual([
        ["IT company-wide", false, "all"],
        ["IT company-wide", true, "all"],
        ["IT only temp", false, "departments"],
        ["IT only temp", true, "departments"],
        ["IT sales", false, "departments"],
        ["IT sales", true, "departments"],
        ["IT temp and eng", false, "departments"],
        ["IT temp and eng", true, "departments"],
      ]);
    }
  });

  it("after the delete, a row targeted only at the department is admins' and editors' only", async () => {
    // The hook stays as defence in depth: rows linked around the Document
    // Service (a previous cms during a rollback) carry no flag; take it off
    // "IT only temp" so the delete has to set it.
    for (const type of TYPES) {
      const rows = await t.strapi.db.query(type.uid).findMany({
        where: { [type.field]: "IT only temp" },
        select: ["id"],
      });
      for (const row of rows) {
        await t.strapi.db
          .query(type.uid)
          .update({ where: { id: row.id }, data: { audience: null } });
      }
    }
    const res = await t.api("admin_role", `/api/departments/${temp.documentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(
      await t.strapi.db.query("api::department.department").count({
        where: { documentId: temp.documentId },
      }),
    ).toBe(0);

    for (const type of TYPES) {
      // Before FX29r, "IT only temp" had no departments left and read as
      // company-wide for member and guest alike.
      expect(await labels("member", type), type.path).toEqual([
        "IT company-wide",
        "IT temp and eng",
      ]);
      expect(await labels("guest", type), type.path).toEqual(["IT company-wide"]);
      for (const moderator of ["admin_role", "editor"] as const) {
        expect(await labels(moderator, type), `${moderator} ${type.path}`).toEqual([
          "IT company-wide",
          "IT only temp",
          "IT sales",
          "IT temp and eng",
        ]);
      }
      // Both rows of each linked document carry the flag, so neither a
      // publish of the draft nor "Discard changes" reopens it; the
      // company-wide document stays company-wide.
      expect(await audiences(type, "IT "), type.path).toEqual([
        ["IT company-wide", false, "all"],
        ["IT company-wide", true, "all"],
        ["IT only temp", false, "departments"],
        ["IT only temp", true, "departments"],
        ["IT sales", false, "departments"],
        ["IT sales", true, "departments"],
        ["IT temp and eng", false, "departments"],
        ["IT temp and eng", true, "departments"],
      ]);
    }
  });

  it("a moderator re-targets a restricted row by linking a department", async () => {
    const engineering = t.fixtures.departments.engineering.documentId;
    for (const type of TYPES) {
      const [row] = await t.strapi.db.query(type.uid).findMany({
        where: { [type.field]: "IT only temp", publishedAt: { $notNull: true } },
        select: ["documentId"],
      });
      const res = await t.api("editor", `${type.path}/${row.documentId}`, {
        method: "PUT",
        json: { data: { departments: { set: [engineering] } } },
      });
      expect(res.status, type.path).toBe(200);
      expect(await labels("member", type), type.path).toEqual([
        "IT company-wide",
        "IT only temp",
        "IT temp and eng",
      ]);
      expect(await labels("guest", type), type.path).toEqual(["IT company-wide"]);
    }
  });

  it.runIf(engine === "postgres")(
    "a link an edit commits while the delete runs is flagged, not cascaded open (Postgres lock)",
    async () => {
      const DOCUMENT = "api::document.document";
      const race = await t.strapi.documents(DEPARTMENT).create({
        data: { name: "Race Temp", slug: "race-temp" },
      });
      const doc = await t.strapi.documents(DOCUMENT).create({
        data: { title: "Race doc", departments: [] },
        status: "published",
      });
      const rows = await t.strapi.db.query(DOCUMENT).findMany({
        where: { documentId: doc.documentId },
        select: ["id", "audience"],
      });
      expect(rows.map((row) => row.audience)).toEqual(["all", "all"]);

      // A save that links both rows of the document to the department
      // around the Document Service (raw SQL, as a previous cms during a
      // rollback: no write-time guard), still open when the delete starts:
      // under Read Committed an unlocked link scan does not see it, and the
      // delete's cascade would then take the link without the flag
      // (company-wide). With the lock the delete waits for the save and its
      // scan sees the link.
      const edit = await holdTransaction(t);
      let deleting: Promise<Settled<unknown>> | undefined;
      try {
        for (const row of rows) {
          await edit.raw(
            `INSERT INTO ${qualified(t, "documents_departments_lnk")} (document_id, department_id) VALUES (?, ?)`,
            [row.id, race.id],
          );
        }
        deleting = settle(t.strapi.documents(DEPARTMENT).delete({ documentId: race.documentId }));
        await waitForLockWait(t);
        await edit.commit();
      } catch (err) {
        await edit.rollback();
        throw err;
      }
      expect(await deleting).toMatchObject({ ok: true });

      const after = await t.strapi.db.query(DOCUMENT).findMany({
        where: { documentId: doc.documentId },
        select: ["audience"],
        populate: { departments: { select: ["id"] } },
      });
      expect(after.map((row) => [row.audience, row.departments])).toEqual([
        ["departments", []],
        ["departments", []],
      ]);
      const titles = async (caller: Caller) => {
        const res = await t.api<{ data: Record<string, unknown>[] }>(
          caller,
          "/api/documents?filters[title][$eq]=Race doc",
        );
        expect(res.status, String(caller)).toBe(200);
        return res.body.data.length;
      };
      expect(await titles("member")).toBe(0);
      expect(await titles("guest")).toBe(0);
      expect(await titles("editor")).toBe(1);
    },
  );

  // -------------------------------------------------------------------------
  // B12-01: copies of a row taken before the delete (the flag as an invariant)

  const createDepartment = (name: string) =>
    t.strapi.documents(DEPARTMENT).create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") },
    });

  /** A published document or quick link that targets `departments`. */
  const createScoped = (type: ScopedType, label: string, departments: string[]) =>
    t.strapi.documents(type.uid).create({
      data: { [type.field]: label, departments, ...required(type) },
      status: "published",
    });

  /** The rows of a document as [published?, audience, number of departments], draft first. */
  const stored = async (type: ScopedType, documentId: string) => {
    const rows = await t.strapi.db.query(type.uid).findMany({
      where: { documentId },
      select: ["audience", "publishedAt"],
      populate: { departments: { select: ["id"] } },
    });
    return rows
      .map((row) => [
        row.publishedAt != null,
        row.audience,
        Array.isArray(row.departments) ? row.departments.length : -1,
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0]));
  };

  /** How many rows labelled `label` the caller reads. */
  const reads = async (caller: Caller, type: ScopedType, label: string) => {
    const res = await t.api<{ data: unknown[] }>(
      caller,
      `${type.path}?filters[${type.field}][$eq]=${encodeURIComponent(label)}`,
    );
    expect(res.status, `${String(caller)} ${type.path}`).toBe(200);
    return res.body.data.length;
  };

  /** Restricted: admins' and editors' only. */
  const expectRestricted = async (type: ScopedType, label: string) => {
    expect(await reads("member", type, label), `member ${label}`).toBe(0);
    expect(await reads("guest", type, label), `guest ${label}`).toBe(0);
    expect(await reads("editor", type, label), `editor ${label}`).toBe(1);
  };

  it("an admin form opened before the delete saves and publishes the row restricted", async () => {
    for (const type of TYPES) {
      const department = await createDepartment(`Form Temp ${type.key}`);
      const label = `Form ${type.key}`;
      const doc = await createScoped(type, label, [department.documentId]);
      // The Content Manager loads the draft into the form ...
      const form = await t.strapi.documents(type.uid).findOne({
        documentId: doc.documentId,
        status: "draft",
      });
      expect(form?.audience, type.key).toBe("departments");
      // ... an admin deletes the department meanwhile ...
      const res = await t.api("admin_role", `/api/departments/${department.documentId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      // ... and the editor saves and publishes: every field as loaded, the
      // relation unchanged (the panel sends it as connect/disconnect only).
      await t.strapi.documents(type.uid).update({
        documentId: doc.documentId,
        data: { [type.field]: form?.[type.field], audience: form?.audience },
      });
      await t.strapi.documents(type.uid).publish({ documentId: doc.documentId });
      // Without the guard the form held Audience 'all', and the document
      // was published company-wide.
      expect(await stored(type, doc.documentId), type.key).toEqual([
        [false, "departments", 0],
        [true, "departments", 0],
      ]);
      await expectRestricted(type, label);
    }
  });

  it("the boot backfill flags the rows linked before the guard, and only those", async () => {
    const { backfillDepartmentAudience } = t.requireBuilt<{
      backfillDepartmentAudience(strapi: unknown): Promise<void>;
    }>("src/utils/department-audience-backfill");
    const engineering = t.fixtures.departments.engineering.documentId;
    const created: Array<{ type: ScopedType; linked: Row; open: Row }> = [];
    for (const type of TYPES) {
      const linked = await createScoped(type, `Backfill linked ${type.key}`, [engineering]);
      const open = await createScoped(type, `Backfill open ${type.key}`, []);
      // As the first boot of batch 12 finds them: the new column NULL on
      // one row, Audience 'all' (written by a cms without the guard) on
      // the other.
      for (const documentId of [linked.documentId, open.documentId]) {
        const rows = await t.strapi.db.query(type.uid).findMany({
          where: { documentId },
          select: ["id"],
          orderBy: { id: "asc" },
        });
        for (const [index, row] of rows.entries()) {
          await t.strapi.db.query(type.uid).update({
            where: { id: row.id },
            data: { audience: index === 0 ? null : "all" },
          });
        }
      }
      created.push({ type, linked, open });
    }

    await backfillDepartmentAudience(t.strapi);
    for (const { type, linked, open } of created) {
      expect(await stored(type, linked.documentId), type.key).toEqual([
        [false, "departments", 1],
        [true, "departments", 1],
      ]);
      const untouched = await t.strapi.db.query(type.uid).findMany({
        where: { documentId: open.documentId },
        select: ["audience"],
        orderBy: { id: "asc" },
      });
      expect(
        untouched.map((row) => row.audience),
        type.key,
      ).toEqual([null, "all"]);
    }
  });

  /**
   * Deletes the department in a transaction that stays open (its flags
   * written, the department and its links deleted, nothing committed)
   * until `release()`.
   */
  const deleteHeldOpen = async (documentId: string) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written: () => void = () => undefined;
    const deleted = new Promise<void>((resolve) => {
      written = resolve;
    });
    const done = settle(
      t.strapi.db.transaction(async () => {
        await t.strapi.documents(DEPARTMENT).delete({ documentId });
        written();
        await gate;
      }),
    );
    await Promise.race([deleted, done]);
    return { release, done };
  };

  /**
   * B12-01 (Codex): `action` reads the row that links the department (a
   * publish the draft, "Discard changes" the published row) before the
   * delete commits, waits for the rows the delete holds, and recreates the
   * other row from its copy afterwards; Strapi drops the deleted department
   * from the copy (allowMissingId). Without the guard the copy said 'all'.
   */
  const raceAgainstDelete = async (action: "publish" | "discardDraft") => {
    for (const type of TYPES) {
      const department = await createDepartment(`Race ${action} ${type.key}`);
      const label = `Race ${action} ${type.key}`;
      const doc = await createScoped(type, label, [department.documentId]);
      const held = await deleteHeldOpen(department.documentId);
      let writing: Promise<Settled<unknown>> | undefined;
      try {
        // The delete is written and still open.
        expect(await Promise.race([held.done, Promise.resolve("open")])).toBe("open");
        const documents = t.strapi.documents(type.uid);
        writing = settle(
          action === "publish"
            ? documents.publish({ documentId: doc.documentId })
            : documents.discardDraft({ documentId: doc.documentId }),
        );
        await waitForLockWait(t);
      } finally {
        held.release();
      }
      expect(await held.done).toMatchObject({ ok: true });
      expect(await writing).toMatchObject({ ok: true });
      // "Discard changes" recreated the draft; the next publish copies it.
      if (action === "discardDraft") {
        await t.strapi.documents(type.uid).publish({ documentId: doc.documentId });
      }
      expect(await stored(type, doc.documentId), `${action} ${type.key}`).toEqual([
        [false, "departments", 0],
        [true, "departments", 0],
      ]);
      await expectRestricted(type, label);
    }
  };

  it.runIf(engine === "postgres")(
    "a publish that read the draft before the delete committed keeps the row restricted (Postgres)",
    async () => {
      await raceAgainstDelete("publish");
    },
  );

  it.runIf(engine === "postgres")(
    "'Discard changes' that read the published row before the delete committed keeps the row restricted (Postgres)",
    async () => {
      await raceAgainstDelete("discardDraft");
    },
  );
});
