import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * apps/web/src/lib/entry-id.ts is a byte-identical mirror of
 * apps/cms/src/utils/entry-id.ts: the web's ICS route refuses exactly the
 * ids the cms handler refuses, before it calls the cms. The cms copy is
 * tested in entry-id.test.ts (and against Postgres 16 in
 * entry-id.pg.test.ts), so this mirror inherits those proofs. Change both
 * files together.
 *
 * Line endings are normalised: a Windows checkout may convert them.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("entry-id mirror", () => {
  it("is byte-identical in cms and web", () => {
    expect(read("./entry-id.ts")).toBe(read("../../../cms/src/utils/entry-id.ts"));
  });
});
