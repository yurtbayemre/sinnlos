import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Generic core routes that the routers removed (`only:` lists, FX01, the
 * training admin-authoring variant, search telemetry) must not exist at
 * all: 404 when nothing lives at the path, 405 when the path serves other
 * methods (@koa/router allowedMethods). Never a 2xx, and never a 401/403,
 * which would mean the route exists and only the grant is missing (one
 * matrix entry away from reopening it). routes.matrix.test.ts pins the
 * route tables; this checks the mounted router of the running cms.
 */

/** [method, path]; `{id}` becomes a real row's documentId where one is needed. */
const REMOVED: ReadonlyArray<readonly [method: string, path: string]> = [
  // poll-vote: no generic route at all (only POST /polls/:id/vote, GET /polls/:id/results).
  ["GET", "/api/poll-votes"],
  ["GET", "/api/poll-votes/1"],
  ["POST", "/api/poll-votes"],
  ["PUT", "/api/poll-votes/1"],
  ["DELETE", "/api/poll-votes/1"],
  // notification: written by the cms only; reads, delete and mark-read stay.
  ["POST", "/api/notifications"],
  ["PUT", "/api/notifications/{notification}"],
  // comment / reaction / kudos: no update.
  ["PUT", "/api/comments/{comment}"],
  ["PUT", "/api/reactions/1"],
  ["PUT", "/api/kudos-entries/1"],
  // lesson-progress: receipts are immutable.
  ["PUT", "/api/lesson-progresses/1"],
  ["DELETE", "/api/lesson-progresses/1"],
  // course / lesson: authored in the admin panel only.
  ["POST", "/api/courses"],
  ["PUT", "/api/courses/1"],
  ["DELETE", "/api/courses/1"],
  ["POST", "/api/lessons"],
  ["PUT", "/api/lessons/1"],
  ["DELETE", "/api/lessons/1"],
  // search-log: create only (the admin summary is its own route).
  ["GET", "/api/search-logs"],
  ["GET", "/api/search-logs/1"],
  ["PUT", "/api/search-logs/1"],
  ["DELETE", "/api/search-logs/1"],
];

const CALLERS: readonly Caller[] = ["admin_role", "editor", "member", "guest", null];

describe.each(testEngines())("removed generic routes on %s", (engine) => {
  let t: TestStrapi;
  let comment: Row;
  let notification: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "IT routes anchor", audience: "all" },
      status: "published",
    });
    const created = await t.api<{ data: Row }>("member", "/api/comments", {
      json: {
        data: {
          body: "original body",
          targetType: "announcement",
          targetDocumentId: announcement.documentId,
        },
      },
    });
    expect(created.status).toBe(201);
    comment = created.body.data;
    notification = await t.strapi.db.query("api::notification.notification").create({
      data: { type: "comment", title: "original title", recipient: t.fixtures.users.member.id },
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const resolve = (path: string) =>
    path
      .replace("{comment}", comment.documentId)
      .replace("{notification}", String(notification.id));

  it.each(REMOVED)("%s %s: 404 or 405 for every caller", async (method, path) => {
    for (const caller of CALLERS) {
      const res = await t.api(caller, resolve(path), {
        method,
        ...(method === "GET" || method === "DELETE"
          ? {}
          : { json: { data: { title: "x", body: "changed" } } }),
      });
      const who = caller === null ? "anonymous" : typeof caller === "string" ? caller : "jwt";
      expect({ who, status: res.status }).toEqual({ who, status: expect.toBeOneOf([404, 405]) });
    }
  });

  it("the rows behind the refused updates are unchanged", async () => {
    const storedComment = await t.strapi.db
      .query("api::comment.comment")
      .findOne({ where: { documentId: comment.documentId } });
    expect(storedComment?.body).toBe("original body");
    const storedNotification = await t.strapi.db
      .query("api::notification.notification")
      .findOne({ where: { id: notification.id } });
    expect(storedNotification?.title).toBe("original title");
  });

  it("the routes that stay answer (control): a grant decides, not a missing route", async () => {
    expect((await t.api("member", "/api/comments")).status).toBe(200);
    expect((await t.api("member", "/api/notifications")).status).toBe(200);
    expect((await t.api("member", "/api/courses")).status).toBe(200);
    expect((await t.api("guest", "/api/courses")).status).toBe(403);
    expect((await t.api(null, "/api/comments")).status).toBe(403);
  });
});
