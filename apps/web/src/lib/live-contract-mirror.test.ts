import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * apps/web/src/lib/live-contract.ts is a byte-identical mirror of
 * apps/cms/src/utils/live-contract.ts (LF04): the cms emits the events and
 * the web bus, stream, subscribe route and client provider deliver them, so
 * both sides must name events, frames and channels the same way until the
 * shared @sinnlos/domain package exists (SH01). The web copy is tested in
 * live-contract.test.ts, the cms copy against TARGET_UIDS in
 * apps/cms/src/utils/live-contract.test.ts. Change both files together.
 *
 * Line endings are normalised: a Windows checkout may convert them.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("live-contract mirror", () => {
  it("is byte-identical in cms and web", () => {
    expect(read("./live-contract.ts")).toBe(read("../../../cms/src/utils/live-contract.ts"));
  });

  it("imports only the CommentTargetType of its sibling comment-target.ts, in both apps", () => {
    const imports = read("./live-contract.ts")
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    expect(imports).toEqual(['import type { CommentTargetType } from "./comment-target";']);
    // The sibling exists and exports the type in both apps.
    for (const sibling of ["./comment-target.ts", "../../../cms/src/utils/comment-target.ts"]) {
      expect(read(sibling), sibling).toMatch(/export type CommentTargetType = /);
    }
  });
});
