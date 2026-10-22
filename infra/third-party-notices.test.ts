import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without types, run by the Dockerfiles
import { buildNotices } from "../scripts/third-party-notices.mjs";

/** scripts/third-party-notices.mjs: the image notices built from pnpm's licenses JSON. */
describe("buildNotices", () => {
  const root = mkdtempSync(join(tmpdir(), "sinnlos-notices-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  };
  const report = {
    MIT: [
      {
        name: "left-pad",
        versions: ["1.0.0", "2.0.0"],
        paths: [pkg("lp1", { LICENSE: "MIT one\n" }), pkg("lp2", { "license.md": "MIT two" })],
        license: "MIT",
      },
    ],
    "Apache-2.0": [
      {
        name: "@scope/apache",
        versions: ["3.1.0"],
        paths: [pkg("ap", { LICENSE: "Apache text", NOTICE: "Notice text", "README.md": "no" })],
        license: "Apache-2.0",
      },
      { name: "bare", versions: ["0.0.1"], paths: [pkg("bare", {})], license: "Unknown" },
    ],
  };

  const { text, missing } = buildNotices(report);

  it("lists every version with the license file from its own path", () => {
    expect(text).toContain("=== left-pad@1.0.0 (MIT)\n--- LICENSE\nMIT one");
    expect(text).toContain("=== left-pad@2.0.0 (MIT)\n--- license.md\nMIT two");
  });

  it("keeps NOTICE files next to the license and skips other files", () => {
    expect(text).toContain("--- LICENSE\nApache text\n--- NOTICE\nNotice text");
    expect(text).not.toContain("README");
  });

  it("marks and reports a version without a license file", () => {
    expect(text).toContain("=== bare@0.0.1 (Unknown)\n(no license file found)");
    expect(missing).toEqual(["bare@0.0.1"]);
  });

  it("starts with the project's own license and sorts the packages", () => {
    expect(text.startsWith("sinnlos is licensed under the GNU Affero General Public License")).toBe(
      true,
    );
    expect(text.indexOf("@scope/apache@3.1.0")).toBeLessThan(text.indexOf("bare@0.0.1"));
    expect(text.indexOf("bare@0.0.1")).toBeLessThan(text.indexOf("left-pad@1.0.0"));
  });
});
