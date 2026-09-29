import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

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
 * a surviving department stays visible to that department.
 */

const TYPES = [
  { uid: "api::document.document", path: "/api/documents", field: "title" },
  { uid: "api::quick-link.quick-link", path: "/api/quick-links", field: "label" },
] as const;

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
            ...(type.uid === "api::quick-link.quick-link" ? { url: "https://example.test" } : {}),
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

  const labels = async (caller: Caller, type: (typeof TYPES)[number]) => {
    const res = await t.api<{ data: Record<string, unknown>[] }>(
      caller,
      `${type.path}?pagination[pageSize]=100&filters[${type.field}][$startsWith]=IT `,
    );
    expect(res.status, `${String(caller)} ${type.path}`).toBe(200);
    return res.body.data.map((row) => String(row[type.field])).sort();
  };

  it("before the delete, the temp-only rows are for nobody outside the department", async () => {
    for (const type of TYPES) {
      expect(await labels("member", type), type.path).toEqual([
        "IT company-wide",
        "IT temp and eng",
      ]);
      expect(await labels("guest", type), type.path).toEqual(["IT company-wide"]);
    }
  });

  it("after the delete, a row targeted only at the department is admins' and editors' only", async () => {
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
      // publish of the draft nor "Discard changes" reopens it.
      const rows = await t.strapi.db.query(type.uid).findMany({
        where: { [type.field]: { $in: ["IT only temp", "IT temp and eng"] } },
        select: ["audience", "publishedAt"],
      });
      expect(rows, type.path).toHaveLength(4);
      expect(new Set(rows.map((row) => row.audience)), type.path).toEqual(new Set(["departments"]));
      const untouched = await t.strapi.db.query(type.uid).findMany({
        where: { [type.field]: { $in: ["IT company-wide", "IT sales"] } },
        select: ["audience"],
      });
      expect(
        untouched.map((row) => row.audience ?? "all"),
        type.path,
      ).not.toContain("departments");
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
});
