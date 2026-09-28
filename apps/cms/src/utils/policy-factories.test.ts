import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import { MALFORMED_ENTRY_IDS } from "./entry-id.test.helper";
import { findByRef, type PolicyDb } from "./policy-factories";

const COMMENT = "api::comment.comment";
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const OTHER_DOC = "m4w8r2t6y1u5i9o3p7a2s6d0";

function commentStub() {
  return createStrapiStub({
    tables: {
      "plugin::users-permissions.user": [{ id: 5, username: "author", email: "a@example.test" }],
      [COMMENT]: [
        {
          id: 7,
          documentId: DOC,
          body: "hello",
          targetType: "announcement",
          targetDocumentId: OTHER_DOC,
          author: { id: 5 },
        },
      ],
    },
  });
}

describe("findByRef (PL01)", () => {
  it("finds a row by numeric id, canonical numeric string or documentId", async () => {
    for (const idParam of [7, "7", DOC]) {
      const strapi = commentStub();
      const row = await findByRef(strapi, COMMENT, idParam);
      expect(row?.id, String(idParam)).toBe(7);
      expect(row?.documentId, String(idParam)).toBe(DOC);
    }
  });

  it("answers null for a missing row", async () => {
    for (const idParam of [8, OTHER_DOC]) {
      await expect(findByRef(commentStub(), COMMENT, idParam), String(idParam)).resolves.toBeNull();
    }
  });

  it("answers null without any query for missing and malformed ids", async () => {
    for (const idParam of [undefined, null, "", 0, -1, 1.5, ...MALFORMED_ENTRY_IDS]) {
      const strapi = commentStub();
      await expect(findByRef(strapi, COMMENT, idParam), String(idParam)).resolves.toBeNull();
      expect(strapi.calls, String(idParam)).toEqual([]);
    }
  });

  it("forwards populate and always selects id and documentId", async () => {
    const strapi = commentStub();
    const row = await findByRef<{ id: number; documentId: string; author?: { id?: number } }>(
      strapi,
      COMMENT,
      DOC,
      { select: ["body"], populate: { author: { select: ["id"] } } },
    );
    expect(row).toEqual({ id: 7, documentId: DOC, body: "hello", author: { id: 5 } });
    expect(strapi.calls).toEqual([
      {
        api: "db",
        uid: COMMENT,
        method: "findOne",
        params: {
          where: { documentId: DOC },
          select: ["id", "documentId", "body"],
          populate: { author: { select: ["id"] } },
        },
      },
    ]);
  });

  it("treats a row without a documentId as no entry", async () => {
    const strapi: PolicyDb = {
      db: {
        query: () => ({
          findOne: async () => ({ id: 7 }),
          findMany: async () => [],
        }),
      },
    };
    await expect(findByRef(strapi, COMMENT, 7)).resolves.toBeNull();
  });
});
