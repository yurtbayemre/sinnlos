import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_ROW_ID, isDocumentId, isRowId, parseEntryRef, parseRowId } from "./entry-id";

/**
 * The id checks that run before a request value reaches a query
 * (EVT-ICS-ID class). A value refused here must be one Postgres cannot
 * compare with an int4 `id` column (entry-id.pg.test.ts proves that side
 * against a real Postgres 16); everything Strapi can address must pass.
 */

// The documentId generator Strapi really uses: @paralleldrive/cuid2 from
// @strapi/core's own dependency tree (not a direct cms dependency).
const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));
const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
const requireFromCore = createRequire(requireFromStrapi.resolve("@strapi/core/package.json"));
const { createId } = requireFromCore("@paralleldrive/cuid2") as { createId: () => string };

describe("parseRowId / isRowId", () => {
  it("accepts positive int4 integers as numbers and canonical decimal strings", () => {
    for (const [input, id] of [
      [1, 1],
      ["1", 1],
      ["42", 42],
      [MAX_ROW_ID, MAX_ROW_ID],
      ["2147483647", MAX_ROW_ID],
    ] as const) {
      expect(parseRowId(input)).toBe(id);
    }
    expect(isRowId(1)).toBe(true);
    expect(isRowId(MAX_ROW_ID)).toBe(true);
  });

  it("refuses everything an int4 lookup cannot take, or that is not canonical", () => {
    for (const input of [
      0,
      -1,
      1.5,
      MAX_ROW_ID + 1,
      1e20,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      "00",
      "01",
      "-1",
      "+1",
      "1.0",
      "1.5",
      "1e3",
      "0x10",
      " 1",
      "1 ",
      "1\n",
      "2147483648",
      "9999999999",
      "10000000000",
      "99999999999999999999",
      "1".repeat(400),
      "Infinity",
      "NaN",
      "",
      "abc",
      null,
      undefined,
      true,
      {},
      [],
      [1],
      { id: 1 },
      BigInt(1),
    ]) {
      expect(parseRowId(input), JSON.stringify(String(input))).toBeNull();
      expect(isRowId(input)).toBe(false);
    }
  });
});

describe("isDocumentId", () => {
  it("accepts what Strapi generates (cuid2 createId, as the document service and the v5 migration use it)", () => {
    for (let i = 0; i < 200; i += 1) {
      const documentId = createId();
      expect(isDocumentId(documentId), documentId).toBe(true);
    }
    expect(isDocumentId("k3v9q2m8x7c4b1n6p5z0r2t8")).toBe(true);
  });

  it("refuses other shapes", () => {
    for (const input of [
      "",
      "doc-1",
      "demo-event-1",
      "k3v9q2m8x7c4b1n6p5z0r2t", // 23
      "k3v9q2m8x7c4b1n6p5z0r2t8x", // 25
      "K3V9Q2M8X7C4B1N6P5Z0R2T8",
      "13v9q2m8x7c4b1n6p5z0r2t8",
      "k3v9q2m8x7c4b1n6p5z0r2-8",
      "k3v9q2m8x7c4b1n6p5z0r2t8\n",
      " k3v9q2m8x7c4b1n6p5z0r2t8",
      "123456789012345678901234",
      "../../../../../../../etc",
      42,
      null,
      undefined,
      { documentId: "k3v9q2m8x7c4b1n6p5z0r2t8" },
    ]) {
      expect(isDocumentId(input), JSON.stringify(input)).toBe(false);
    }
  });
});

describe("parseEntryRef", () => {
  it("reads a row id or a documentId into the matching where", () => {
    expect(parseEntryRef("7")).toEqual({ id: 7 });
    expect(parseEntryRef(7)).toEqual({ id: 7 });
    expect(parseEntryRef("k3v9q2m8x7c4b1n6p5z0r2t8")).toEqual({
      documentId: "k3v9q2m8x7c4b1n6p5z0r2t8",
    });
  });

  it("is null for a missing, malformed or out-of-range value", () => {
    for (const input of [undefined, null, "", "abc", "1.5", "0", "2147483648", "doc-1", 0, 1e20]) {
      expect(parseEntryRef(input), JSON.stringify(input)).toBeNull();
    }
  });
});
