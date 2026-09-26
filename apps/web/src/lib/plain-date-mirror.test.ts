import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * apps/web/src/lib/plain-date.ts is a byte-identical mirror of
 * apps/cms/src/utils/plain-date.ts (datetime contract, deep-dive decision
 * 04, C5): one set of Intl-only calendar-date rules for both apps until the
 * shared @sinnlos/domain package exists (SH01). The cms copy is tested
 * against the Temporal time module (time-parity.test.ts), so this mirror
 * inherits that proof. Change both files together.
 *
 * Line endings are normalised: a Windows checkout may convert them.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("plain-date mirror", () => {
  it("is byte-identical in cms and web", () => {
    expect(read("./plain-date.ts")).toBe(read("../../../cms/src/utils/plain-date.ts"));
  });
});
