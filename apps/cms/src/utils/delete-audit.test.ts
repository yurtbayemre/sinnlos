import { describe, expect, it } from "vitest";

import { runWithDeleteAudit, recordDelete } from "./delete-audit";
import { runInAuthoringScope } from "./document-lock";

/**
 * The delete trail (owner, 2026-10-13; batch 16 lane 16A): one audit row
 * per ad and per file delete through batch 15's recorder, with the actor
 * from the request context and nothing else about the request.
 */

function makeStrapi(ctx?: unknown) {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    strapi: {
      db: {
        query: (uid: string) => ({
          create: async ({ data }: { data: Record<string, unknown> }) => {
            expect(uid).toBe("api::audit-event.audit-event");
            rows.push(data);
            return data;
          },
        }),
      },
      requestContext: { get: () => ctx },
    },
  };
}

const userCtx = (role: string) => ({
  state: {
    auth: { strategy: { name: "users-permissions" } },
    user: { id: 12, role: { type: role }, email: "x@example.test" },
  },
  request: { ip: "203.0.113.9", headers: { authorization: "Bearer secret" } },
});

describe("recordDelete: who deleted which ad", () => {
  it("records the author's own delete through the API: class author, role in detail", async () => {
    const { strapi, rows } = makeStrapi(userCtx("member"));
    await recordDelete(strapi, {
      kind: "classified",
      documentId: "ad1",
      title: "Bike",
      authorId: 12,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        action: "delete",
        targetUid: "api::classified.classified",
        targetDocumentId: "ad1",
        actorKind: "user",
        actorUserId: 12,
        actorAdminId: null,
        actorClass: "author",
        source: "content-api",
        detail: "role: member; title: Bike",
        keys: null,
      }),
    ]);
  });

  it("records a moderator's takedown as class moderator; a moderator's own ad as author", async () => {
    const { strapi, rows } = makeStrapi(userCtx("editor"));
    await recordDelete(strapi, {
      kind: "classified",
      documentId: "ad1",
      title: "Bike",
      authorId: 5,
    });
    expect(rows[0]).toMatchObject({
      actorKind: "user",
      actorUserId: 12,
      actorClass: "moderator",
      detail: "role: editor; title: Bike",
    });
    await recordDelete(strapi, {
      kind: "classified",
      documentId: "ad2",
      title: "Own",
      authorId: 12,
    });
    expect(rows[1]).toMatchObject({ actorClass: "author" });
  });

  it("uses the authoring scope's class where one is set (batch 15's vocabulary)", async () => {
    const { strapi, rows } = makeStrapi(userCtx("department_head"));
    await runInAuthoringScope({ roleClass: "departmentAuthor" }, () =>
      recordDelete(strapi, { kind: "file", file: { id: 1, documentId: "f1" } }),
    );
    expect(rows[0]).toMatchObject({ actorClass: "departmentAuthor" });
  });

  it("gives no class to a user deleting someone else's item without being a moderator", async () => {
    const { strapi, rows } = makeStrapi(userCtx("member"));
    await recordDelete(strapi, {
      kind: "classified",
      documentId: "ad1",
      title: "Bike",
      authorId: 5,
    });
    expect(rows[0]).toMatchObject({ actorClass: null, detail: "role: member; title: Bike" });
  });

  it("records an admin-panel delete with the admin's id", async () => {
    const { strapi, rows } = makeStrapi({
      state: {
        auth: { strategy: { name: "admin" } },
        user: { id: 3, roles: [{ code: "strapi-super-admin" }] },
      },
    });
    await recordDelete(strapi, { kind: "classified", documentId: "ad1", title: "Bike" });
    expect(rows[0]).toMatchObject({
      actorKind: "admin",
      actorAdminId: 3,
      actorUserId: null,
      actorClass: null,
      source: "admin",
    });
  });

  it("records a janitor's delete as system, source cron", async () => {
    const { strapi, rows } = makeStrapi(undefined);
    await runWithDeleteAudit({ source: "cron" }, () =>
      recordDelete(strapi, { kind: "classified", documentId: "ad1", title: "Old bike" }),
    );
    expect(rows[0]).toMatchObject({ actorKind: "system", source: "cron", actorClass: null });
  });

  it("follows the scheduler's authoring scope (source cron)", async () => {
    const { strapi, rows } = makeStrapi(undefined);
    await runInAuthoringScope({ source: "cron" }, () =>
      recordDelete(strapi, { kind: "file", file: { id: 1, documentId: "f1" } }),
    );
    expect(rows[0]).toMatchObject({ actorKind: "system", source: "cron" });
  });

  it("stores no IP address, token or other request data", async () => {
    const { strapi, rows } = makeStrapi(userCtx("member"));
    await recordDelete(strapi, { kind: "classified", documentId: "ad1", title: "Bike" });
    const text = JSON.stringify(rows);
    for (const leaked of ["203.0.113.9", "secret", "x@example.test"])
      expect(text).not.toContain(leaked);
  });
});

describe("recordDelete: which file", () => {
  it("names id, mime, bytes, the related ad and the name", async () => {
    const { strapi, rows } = makeStrapi(userCtx("member"));
    await runWithDeleteAudit(
      { related: { uid: "api::classified.classified", documentId: "ad1" } },
      () =>
        recordDelete(strapi, {
          kind: "file",
          file: {
            id: 9,
            documentId: "f9",
            name: "bike.jpg",
            mime: "image/jpeg",
            size: 1.5,
            sizeInBytes: 1536,
          },
        }),
    );
    expect(rows[0]).toMatchObject({
      targetUid: "plugin::upload.file",
      targetDocumentId: "f9",
      actorClass: null,
      detail:
        "role: member; file 9, image/jpeg, 1536 B, of api::classified.classified ad1: bike.jpg",
    });
  });

  it("names the rows still linking a Media Library file, and clips to 255 characters", async () => {
    const { strapi, rows } = makeStrapi(undefined);
    await recordDelete(strapi, {
      kind: "file",
      file: { id: 9, name: "x".repeat(400), mime: "application/pdf", size: 2 },
      links: [{ relatedType: "api::document.document", relatedId: 4 }],
    });
    expect(rows[0].targetDocumentId).toBe("file-9");
    expect(String(rows[0].detail)).toMatch(
      /^file 9, application\/pdf, 2000 B, linked by api::document\.document#4: x+$/,
    );
    expect(Array.from(String(rows[0].detail))).toHaveLength(255);
  });
});

describe("recordDelete: the uploader is the author of a file", () => {
  it("classes the uploader author, a moderator removing another's upload moderator", async () => {
    const own = makeStrapi(userCtx("member"));
    await recordDelete(own.strapi, {
      kind: "file",
      file: { id: 3, documentId: "f3", provider_metadata: { uploadedBy: 12 } },
    });
    expect(own.rows[0]).toMatchObject({ actorClass: "author" });
    const other = makeStrapi(userCtx("admin_role"));
    await recordDelete(other.strapi, {
      kind: "file",
      file: { id: 3, documentId: "f3", provider_metadata: { uploadedBy: 99 } },
    });
    expect(other.rows[0]).toMatchObject({ actorClass: "moderator" });
  });
});
