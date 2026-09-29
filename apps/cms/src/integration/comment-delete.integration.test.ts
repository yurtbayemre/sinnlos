import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * DELETE /api/comments/:id over HTTP, byte for byte (PL03).
 *
 * Until batch 12 the comment controller checked ownership itself and
 * answered with ctx.notFound()/ctx.forbidden(); since then the route policy
 * global::is-comment-author checks it (ownerGate) and the controller keeps
 * only the id translation and the 404. The web and every direct API
 * consumer must not see a difference, so the exact status and body of
 * every answer are pinned here, the refusals included (a PolicyError would
 * answer 403 with "Policy Failed" instead of "Forbidden"):
 *   - the author deletes by numeric id and by documentId;
 *   - admin_role and editor delete anyone's comment (moderation);
 *   - anyone else gets the controller's former 403;
 *   - a missing, malformed or out-of-range id is the controller's 404 for
 *     every caller that holds the grant;
 *   - guest holds no delete grant (403 from users-permissions, before any
 *     policy), and an anonymous request is refused the same way.
 */

const COMMENT = "api::comment.comment";

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

const FORBIDDEN =
  '{"data":null,"error":{"status":403,"name":"ForbiddenError","message":"Forbidden","details":{}}}';
const NOT_FOUND =
  '{"data":null,"error":{"status":404,"name":"NotFoundError","message":"Not Found","details":{}}}';

/** Ids that name no comment: missing, malformed, out of range, a documentId never generated. */
const UNKNOWN_IDS = ["999999", "abc", "0", "2147483648", "zzzzzzzzzzzzzzzzzzzzzzzz"];

describe.each(testEngines())("comment delete on %s", (engine) => {
  let t: TestStrapi;
  let targetDocumentId: string;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "IT comment delete", audience: "all" },
      status: "published",
    });
    targetDocumentId = announcement.documentId;
    // The publish fan-out runs after the commit; let it finish before the
    // suite, and before stop() closes the pool under it.
    await t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
  });

  afterAll(async () => {
    await t?.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
    await t?.stop();
  });

  /** A new comment by `author` on the announcement. */
  const comment = async (author: Caller = "member"): Promise<Row> => {
    const res = await t.api<{ data: Row }>(author, "/api/comments", {
      json: { data: { body: "to be deleted", targetType: "announcement", targetDocumentId } },
    });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  const remove = (caller: Caller, id: string | number) =>
    t.api(caller, `/api/comments/${id}`, { method: "DELETE" });

  const exists = async (row: Row) =>
    (await t.strapi.db.query(COMMENT).count({ where: { id: row.id } })) === 1;

  it("the author deletes by numeric id and by documentId", async () => {
    for (const ref of ["id", "documentId"] as const) {
      const row = await comment();
      const res = await remove("member", row[ref] as string | number);
      expect(res.status, ref).toBe(204);
      expect(res.text, ref).toBe("");
      expect(await exists(row), ref).toBe(false);
    }
  });

  it("admin_role and editor delete anyone's comment", async () => {
    for (const moderator of ["admin_role", "editor"] as const) {
      const row = await comment();
      const res = await remove(moderator, row.id);
      expect(res.status, moderator).toBe(204);
      expect(await exists(row), moderator).toBe(false);
    }
  });

  it("refuses everyone else with the former 403 body, and keeps the comment", async () => {
    const row = await comment();
    for (const stranger of ["department_head", "team_lead", "authenticated"] as const) {
      for (const ref of [row.id, row.documentId]) {
        const res = await remove(stranger, ref);
        expect([stranger, res.status, res.text]).toEqual([stranger, 403, FORBIDDEN]);
      }
    }
    expect(await exists(row)).toBe(true);
  });

  it("answers an unknown id with the former 404 body, for the author and the moderators", async () => {
    for (const caller of ["member", "team_lead", "editor", "admin_role"] as const) {
      for (const id of UNKNOWN_IDS) {
        const res = await remove(caller, id);
        expect([caller, id, res.status, res.text]).toEqual([caller, id, 404, NOT_FOUND]);
      }
    }
  });

  it("refuses guest and an anonymous request before any policy (no delete grant)", async () => {
    const row = await comment();
    for (const caller of ["guest", null] as const) {
      for (const id of [String(row.id), "999999"]) {
        const res = await remove(caller, id);
        expect([caller, id, res.status]).toEqual([caller, id, 403]);
      }
    }
    expect(await exists(row)).toBe(true);
  });
});
