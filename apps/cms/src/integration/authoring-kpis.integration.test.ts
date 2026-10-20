import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * KPIs (v0.19, "Kennzahlen") through the v2 write model on SQLite and
 * Postgres 16: department heads author their own department's figures,
 * moderators any; team leads only read (owner decision 2026-10-20). The
 * values are checked by the shared rules (@sinnlos/domain kpi.ts), keys
 * aligned with the KPI's rhythm as stored ⊕ payload; every staff role
 * reads published KPIs, guests none.
 */
const K = "api::kpi.kpi";
const P = "kpis";

describe.each(testEngines())("authoring KPIs on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const rowOf = async (documentId: string) => {
    const [row] = await t.strapi.db.query(K).findMany({
      where: { documentId, publishedAt: { $null: true } },
      populate: { department: true, ownerDepartment: true, author: true },
    });
    return row as unknown as Record<string, unknown> & {
      department: { id: number } | null;
      ownerDepartment: { id: number } | null;
      author: { id: number } | null;
      values: unknown;
      period: unknown;
    };
  };

  it("a department head publishes a KPI for their department; it is pinned and stored sorted", async () => {
    const res = await api.create(
      "department_head",
      P,
      {
        name: "Verladene Kubikmeter",
        unit: "m³",
        period: "quarter",
        aggregation: "sum",
        values: { "2026-07-01": 1250.5, "2026-01-01": 980, "2026-04-01": 1100 },
      },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    const row = await rowOf(res.body.data.documentId);
    const engineering = t.fixtures.departments.engineering.id;
    expect(row.department?.id).toBe(engineering);
    expect(row.ownerDepartment?.id).toBe(engineering);
    expect(row.author?.id).toBe(t.fixtures.users.department_head.id);
    expect(Object.keys(row.values as object)).toEqual(["2026-01-01", "2026-04-01", "2026-07-01"]);

    const read = await t.api<{ data: { name: string; values: unknown }[] }>("member", "/api/kpis");
    expect(read.status).toBe(200);
    expect(read.body.data.map((kpi) => kpi.name)).toContain("Verladene Kubikmeter");
    expect((await t.api("guest", "/api/kpis")).status).toBe(403);
  });

  it("refuses values off the rhythm, and a new rhythm while old values are left", async () => {
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { period: "quarter", values: { "2026-02-01": 1 } },
        { keys: ["values"], codes: { values: "invalid" } },
      ],
      [{ values: { "2026-02-15": 1 } }, { keys: ["values"], codes: { values: "invalid" } }],
      [{ values: { "2026-02-01": "7" } }, { keys: ["values"], codes: { values: "invalid" } }],
      [{ values: [1, 2] }, { keys: ["values"], codes: { values: "invalid" } }],
      [{ period: "week" }, { keys: ["period"], codes: { period: "invalid" } }],
      [{ aggregation: "avg" }, { keys: ["aggregation"], codes: { aggregation: "invalid" } }],
    ];
    for (const [data, details] of bad) {
      const res = await api.create("department_head", P, { name: "Bad", ...data }, "published");
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error?.details, JSON.stringify(data)).toEqual(details);
    }

    // Monthly by default; switching to years is refused while months are stored.
    const monthly = await api.create(
      "department_head",
      P,
      { name: "Reinigungen", values: { "2026-03-01": 40 } },
      "published",
    );
    expect(monthly.status, monthly.text).toBe(201);
    expect((await rowOf(monthly.body.data.documentId)).period).toBe("month");
    const switched = await api.update(
      "department_head",
      P,
      monthly.body.data.documentId,
      { period: "year" },
      { version: monthly.body.data.version, status: "published" },
    );
    expect(switched.status).toBe(400);
    expect(switched.body.error?.details).toEqual({
      keys: ["period"],
      codes: { period: "invalid" },
    });
    const cleared = await api.update(
      "department_head",
      P,
      monthly.body.data.documentId,
      { period: "year", values: { "2026-01-01": 480 } },
      { version: monthly.body.data.version, status: "published" },
    );
    expect(cleared.status, cleared.text).toBe(200);
  });

  it("keeps department heads in their own department; team leads only read", async () => {
    const sales = t.fixtures.departments.sales.documentId;
    const res = await api.create(
      "department_head",
      P,
      { name: "Fremd", department: sales },
      "published",
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.details).toEqual({ keys: ["department"] });
    expect((await api.create("team_lead", P, { name: "x" }, "published")).status).toBe(403);
    expect((await api.list("team_lead", P)).status).toBe(403);

    for (const department of [sales, null]) {
      const other = await api.create("editor", P, { name: "Andere", department }, "published");
      expect(other.status, other.text).toBe(201);
      const refused = await api.update(
        "department_head",
        P,
        other.body.data.documentId,
        { unit: "x" },
        { version: other.body.data.version, status: "published" },
      );
      expect([403, 404], String(department)).toContain(refused.status);
    }
  });

  it("validates admin-panel writes too (the lifecycle)", async () => {
    await expect(
      t.strapi.documents(K).create({ data: { name: "Panel", values: '{"2026-01-01":"x"}' } }),
    ).rejects.toThrow(/a number within/);
    await expect(
      t.strapi.documents(K).create({
        data: { name: "Panel", period: "year", values: '{"2026-04-01":1}' },
      }),
    ).rejects.toThrow(/not the first day of a year/);
    const created = await t.strapi.documents(K).create({
      data: { name: "Panel ok", values: '{"2026-02-01":2,"2026-01-01":1}' },
    });
    expect((await rowOf(created.documentId)).values).toEqual({ "2026-01-01": 1, "2026-02-01": 2 });

    // A partial update is checked as it will be stored: a new rhythm alone, values alone.
    await expect(
      t.strapi.documents(K).update({ documentId: created.documentId, data: { period: "year" } }),
    ).rejects.toThrow(/not the first day of a year/);
    const yearly = await t.strapi.documents(K).create({
      data: { name: "Panel yearly", period: "year", values: '{"2025-01-01":7}' },
    });
    await expect(
      t.strapi.documents(K).update({
        documentId: yearly.documentId,
        data: { values: '{"2026-03-01":1}' },
      }),
    ).rejects.toThrow(/not the first day of a year/);
    await t.strapi.documents(K).update({
      documentId: yearly.documentId,
      data: { values: '{"2026-01-01":8,"2025-01-01":7}' },
    });
    expect((await rowOf(yearly.documentId)).values).toEqual({ "2025-01-01": 7, "2026-01-01": 8 });
  });

  it("lets members only read, and keeps delete with the moderators", async () => {
    expect((await api.create("member", P, { name: "x" }, "published")).status).toBe(403);
    const kpi = await api.create("department_head", P, { name: "Zum Löschen" }, "published");
    expect(kpi.status, kpi.text).toBe(201);
    expect(
      (await api.remove("department_head", P, kpi.body.data.documentId, kpi.body.data.version))
        .status,
    ).toBe(403);
  });
});
