import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/INSTALL.md clones the release it belongs to (v0.29, S4): the version
 * bump changes the root package.json and this line together.
 * scripts/ci-scope.mjs runs the unit tests on an INSTALL-only change too.
 */

const ROOT = join(__dirname, "..");

describe("docs/INSTALL.md", () => {
  it("clones the tag of the root package version", () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const install = readFileSync(join(ROOT, "docs", "INSTALL.md"), "utf8");
    expect(install.match(/git clone --branch \S+/g)).toEqual([`git clone --branch v${version}`]);
  });
});
