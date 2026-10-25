import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * S6 (v0.29.3): cmdk's Command.Empty and Command.Loading render a
 * presentation div and a progressbar. Inside Command.List (role=listbox)
 * they were its only children while nothing matched or loaded, which axe
 * reports (aria-required-children); outside it the listbox is just empty,
 * which axe only marks for review. The node test runner has no DOM, so this
 * pins the structure in the source.
 */
const SOURCE = readFileSync(join(__dirname, "search-command.tsx"), "utf8");

describe("search palette markup", () => {
  it("keeps the empty and loading states outside the listbox", () => {
    const list = SOURCE.slice(SOURCE.indexOf("<Command.List"), SOURCE.indexOf("</Command.List>"));
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain("Command.Empty");
    expect(list).not.toContain("Command.Loading");
    expect(SOURCE).toContain("<Command.Empty");
    expect(SOURCE).toContain("<Command.Loading");
  });
});
