import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * Quick links through the v2 write model (deep-dive decision 06 §B1.3;
 * batch 15 lane 15A) on SQLite and Postgres 16: an http(s) URL without
 * credentials or an internal path (never protocol-relative), the icon keys
 * of @sinnlos/domain, the category enum, the order range, the derived
 * `audience`, the schedule fields (publishAt, unpublishAt) and moderators
 * only.
 */
const Q = "api::quick-link.quick-link";
const P = "quick-links";

describe.each(testEngines())("authoring quick links on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("accepts an internal path and an external URL with an icon key, a category and an order", async () => {
    for (const url of ["/wiki/hr", "https://payroll.example.com/login"]) {
      const res = await api.create(
        "editor",
        P,
        { label: `Link ${url}`, url, icon: "Wallet", category: "hr", order: 5 },
        "published",
      );
      expect(res.status, res.text).toBe(201);
      expect(res.body.data).toMatchObject({
        status: "published",
        publishAt: null,
        unpublishAt: null,
      });
    }
    const links = await t.api<{ data: { label: string }[] }>("member", "/api/quick-links");
    expect(links.body.data.map((link) => link.label)).toEqual(
      expect.arrayContaining(["Link /wiki/hr", "Link https://payroll.example.com/login"]),
    );
  });

  it("refuses protocol-relative, scripted and credentialed URLs, unknown icons, categories and orders", async () => {
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ url: "//evil.example" }, { keys: ["url"], codes: { url: "invalidUrl" } }],
      [{ url: "javascript:alert(1)" }, { keys: ["url"], codes: { url: "invalidUrl" } }],
      [{ url: "https://user:pw@example.com" }, { keys: ["url"], codes: { url: "invalidUrl" } }],
      [{ url: "/\\evil.example" }, { keys: ["url"], codes: { url: "invalidUrl" } }],
      [{ icon: "wallet" }, { keys: ["icon"], codes: { icon: "invalid" } }],
      [{ icon: "constructor" }, { keys: ["icon"], codes: { icon: "invalid" } }],
      [{ category: "misc" }, { keys: ["category"], codes: { category: "invalid" } }],
      [{ order: 10_001 }, { keys: ["order"], codes: { order: "invalid" } }],
      [{ audience: "all" }, { keys: ["audience"] }],
    ];
    for (const [data, details] of bad) {
      const res = await api.create("editor", P, { label: "Bad", url: "/ok", ...data }, "draft");
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error?.details, JSON.stringify(data)).toEqual(details);
    }
  });

  it("schedules a publish and a withdrawal in order, and derives the audience from departments", async () => {
    const res = await api.create(
      "editor",
      P,
      { label: "Scheduled", url: "/x", departments: [t.fixtures.departments.sales.documentId] },
      "draft",
    );
    expect(res.status).toBe(201);
    const id = res.body.data.documentId;
    const [row] = await t.strapi.db.query(Q).findMany({ where: { documentId: id } });
    expect(row.audience).toBe("departments");
    const publishAt = new Date(Date.now() + 3_600_000).toISOString();
    const wrong = await api.update(
      "editor",
      P,
      id,
      { publishAt, unpublishAt: publishAt },
      { version: res.body.data.version },
    );
    expect(wrong.body.error?.details).toEqual({
      keys: ["unpublishAt"],
      codes: { unpublishAt: "unpublishBeforePublish" },
    });
    const unpublishAt = new Date(Date.now() + 7_200_000).toISOString();
    const ok = await api.update(
      "editor",
      P,
      id,
      { publishAt, unpublishAt },
      { version: res.body.data.version },
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.data).toMatchObject({ publishAt, unpublishAt, status: "draft" });
    const list = await api.list<{ documentId: string; publishAt: string | null }>(
      "editor",
      P,
      "status=scheduled",
    );
    expect(list.body.data.map((entry) => entry.documentId)).toContain(id);
    const everyone = await api.update(
      "editor",
      P,
      id,
      { departments: null },
      { version: ok.body.data.version },
    );
    expect(everyone.status).toBe(200);
    const [after] = await t.strapi.db.query(Q).findMany({ where: { documentId: id } });
    expect(after.audience).toBe("all");
  });

  it("is moderators-only: department heads, members and guests get 403", async () => {
    for (const role of ["department_head", "member", "guest"] as const) {
      expect((await api.create(role, P, { label: "x", url: "/x" }, "draft")).status, role).toBe(
        403,
      );
      expect((await api.list(role, P)).status, role).toBe(403);
    }
  });
});
