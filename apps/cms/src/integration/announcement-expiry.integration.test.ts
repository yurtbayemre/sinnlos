import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * Announcement expiry on the real query engine (DA02; owner answer
 * 2026-09-29 (b)): `expiresAt` is an instant (timestamptz on Postgres,
 * the datetime contract); from that instant on, the announcement leaves
 * the list and single reads of every non-bypass caller, and its comment
 * thread goes with it (read and write, the answer of a missing target).
 * admin_role and editor keep reading it. The digest's query is pinned
 * against the shared stub in digest/send-digests.test.ts.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const HOUR = 3_600_000;

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

describe.each(testEngines())("announcement expiry on %s", (engine) => {
  let t: TestStrapi;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const now = Date.now();
    // An author, so a comment's notification (written after the comment's
    // commit) is something the test can wait for before stop().
    const author = t.fixtures.users.editor.id;
    const create = async (title: string, expiresAt: string | null) => {
      const row = await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title, audience: "all", expiresAt, author },
        status: "published",
      });
      ids[title] = row.documentId;
    };
    await create("IT ended an hour ago", new Date(now - HOUR).toISOString());
    await create("IT ends tomorrow", new Date(now + 24 * HOUR).toISOString());
    await create("IT never ends", null);
    // The publish fan-outs run after the commit; let them finish before the
    // suite reads, and before stop() closes the pool under them.
    await t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
  });

  afterAll(async () => {
    await t?.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
    await t?.stop();
  });

  const titles = async (role: "member" | "editor" | "admin_role") => {
    const res = await t.api<{ data: { title: string }[] }>(
      role,
      "/api/announcements?filters[title][$startsWith]=IT &pagination[pageSize]=50",
    );
    expect(res.status).toBe(200);
    return res.body.data.map((row) => row.title).sort();
  };

  it("lists an expired announcement only for admin_role and editor", async () => {
    expect(await titles("member")).toEqual(["IT ends tomorrow", "IT never ends"]);
    for (const role of ["editor", "admin_role"] as const) {
      expect(await titles(role), role).toEqual([
        "IT ended an hour ago",
        "IT ends tomorrow",
        "IT never ends",
      ]);
    }
    const single = await t.api("member", `/api/announcements/${ids["IT ended an hour ago"]}`);
    expect(single.status).toBe(404);
  });

  it("closes the thread of an expired announcement like a missing target", async () => {
    const comment = (targetDocumentId: string) =>
      t.api<{ error?: { message?: string } }>("member", "/api/comments", {
        json: { data: { body: "late", targetType: "announcement", targetDocumentId } },
      });
    const expired = await comment(ids["IT ended an hour ago"]);
    const missing = await comment("zzzzzzzzzzzzzzzzzzzzzzzz");
    expect([expired.status, expired.text]).toEqual([missing.status, missing.text]);
    expect(expired.status).toBe(400);
    expect((await comment(ids["IT ends tomorrow"])).status).toBe(201);
    // The author's notification is written after the comment's commit;
    // wait for it, so no query is in flight when the suite stops.
    await expect
      .poll(() =>
        t.strapi.db.query("api::notification.notification").count({
          where: { type: "comment", recipient: t.fixtures.users.editor.id },
        }),
      )
      .toBe(1);
  });
});
