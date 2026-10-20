import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * Duty plans (v0.18, "Zuständigkeiten") through the v2 write model on SQLite
 * and Postgres 16: department heads AND team leads author their own
 * department's plans (owner decision 2026-10-20), moderators any plan; the
 * shift templates and shifts are checked by the shared rules and stored
 * normalised; every staff role reads published plans, guests none.
 */
const D = "api::duty-plan.duty-plan";
const P = "duty-plans";

const NIGHT = { label: "Nacht", start: "22:00", end: "06:00" };

describe.each(testEngines())("authoring duty plans on %s", (engine) => {
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
    const [row] = await t.strapi.db.query(D).findMany({
      where: { documentId, publishedAt: { $null: true } },
      populate: { department: true, ownerDepartment: true, author: true },
    });
    return row as unknown as Record<string, unknown> & {
      department: { id: number } | null;
      ownerDepartment: { id: number } | null;
      author: { id: number } | null;
      shifts: unknown;
    };
  };

  it("a team lead publishes a plan for their department; it is pinned and stored normalised", async () => {
    const member = t.fixtures.users.member;
    const res = await api.create(
      "team_lead",
      P,
      {
        name: "Schlüsseldienst",
        note: "Schlüssel im Fach 3",
        shiftTemplates: [NIGHT],
        shifts: [
          {
            userId: member.id,
            startsAt: "2026-10-24T22:00:00+02:00",
            endsAt: "2026-10-25T06:00:00+01:00",
          },
        ],
      },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({ status: "published" });
    const row = await rowOf(res.body.data.documentId);
    const engineering = t.fixtures.departments.engineering.id;
    expect(row.department?.id).toBe(engineering);
    expect(row.ownerDepartment?.id).toBe(engineering);
    expect(row.author?.id).toBe(t.fixtures.users.team_lead.id);
    expect(row.shifts).toEqual([
      {
        userId: member.id,
        startsAt: "2026-10-24T20:00:00.000Z",
        endsAt: "2026-10-25T05:00:00.000Z",
      },
    ]);

    const read = await t.api<{ data: { name: string; shifts: unknown }[] }>(
      "member",
      "/api/duty-plans",
    );
    expect(read.status).toBe(200);
    expect(read.body.data.map((plan) => plan.name)).toContain("Schlüsseldienst");
    expect((await t.api("guest", "/api/duty-plans")).status).toBe(403);
  });

  it("keeps department authors in their own department", async () => {
    const sales = t.fixtures.departments.sales.documentId;
    for (const role of ["team_lead", "department_head"] as const) {
      const res = await api.create(role, P, { name: "Fremd", department: sales }, "published");
      expect(res.status, role).toBe(400);
      expect(res.body.error?.details, role).toEqual({ keys: ["department"] });
    }

    // A moderator's plan belongs to its department, so that department's authors maintain it.
    const engineeringPlan = await api.create(
      "editor",
      P,
      { name: "Schichtleitung Früh", department: t.fixtures.departments.engineering.documentId },
      "published",
    );
    expect(engineeringPlan.status, engineeringPlan.text).toBe(201);
    const id = engineeringPlan.body.data.documentId;
    expect((await rowOf(id)).ownerDepartment?.id).toBe(t.fixtures.departments.engineering.id);
    const edited = await api.update(
      "team_lead",
      P,
      id,
      { note: "Übergabe an der Rampe" },
      { version: engineeringPlan.body.data.version, status: "published" },
    );
    expect(edited.status, edited.text).toBe(200);

    // A Sales plan and a company-wide plan stay out of reach.
    for (const department of [sales, null]) {
      const other = await api.create("editor", P, { name: "Andere", department }, "published");
      expect(other.status, other.text).toBe(201);
      const refused = await api.update(
        "department_head",
        P,
        other.body.data.documentId,
        { note: "x" },
        { version: other.body.data.version, status: "published" },
      );
      expect([403, 404], String(department)).toContain(refused.status);
    }
  });

  it("refuses invalid templates and shifts with field codes", async () => {
    const member = t.fixtures.users.member.id;
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        {
          shifts: [
            { userId: member, startsAt: "2026-10-21T12:00:00Z", endsAt: "2026-10-21T04:00:00Z" },
          ],
        },
        { keys: ["shifts"], codes: { shifts: "endBeforeStart" } },
      ],
      [
        {
          shifts: [
            { userId: member, startsAt: "2026-10-21T06:00:00", endsAt: "2026-10-21T14:00:00" },
          ],
        },
        { keys: ["shifts"], codes: { shifts: "invalid" } },
      ],
      [
        { shiftTemplates: [{ label: "Früh", start: "6:00", end: "14:00" }] },
        { keys: ["shiftTemplates"], codes: { shiftTemplates: "invalid" } },
      ],
      [{ ownerDepartment: t.fixtures.departments.sales.documentId }, { keys: ["ownerDepartment"] }],
    ];
    for (const [data, details] of bad) {
      const res = await api.create("department_head", P, { name: "Bad", ...data }, "published");
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error?.details, JSON.stringify(data)).toEqual(details);
    }
  });

  it("validates admin-panel writes too (the lifecycle)", async () => {
    await expect(
      t.strapi.documents(D).create({
        data: { name: "Panel", shifts: '[{"userId":1,"startsAt":"x","endsAt":"y"}]' },
      }),
    ).rejects.toThrow(/startsAt and endsAt must be instants/);
    const created = await t.strapi.documents(D).create({
      data: {
        name: "Panel ok",
        shifts:
          '[{"userId":1,"startsAt":"2026-10-21T06:00:00+02:00","endsAt":"2026-10-21T14:00:00+02:00"}]',
      },
    });
    const row = await rowOf(created.documentId);
    expect(row.shifts).toEqual([
      { userId: 1, startsAt: "2026-10-21T04:00:00.000Z", endsAt: "2026-10-21T12:00:00.000Z" },
    ]);
  });

  it("lets members only read, and keeps delete with the moderators", async () => {
    expect((await api.create("member", P, { name: "x" }, "published")).status).toBe(403);
    expect((await api.list("member", P)).status).toBe(403);
    const plan = await api.create("department_head", P, { name: "Zum Löschen" }, "published");
    expect(plan.status, plan.text).toBe(201);
    expect(
      (await api.remove("department_head", P, plan.body.data.documentId, plan.body.data.version))
        .status,
    ).toBe(403);
    const list = await api.list<{ documentId: string }>("team_lead", P);
    expect(list.status).toBe(200);
    expect(list.body.data.map((entry) => entry.documentId)).toContain(plan.body.data.documentId);
  });
});
