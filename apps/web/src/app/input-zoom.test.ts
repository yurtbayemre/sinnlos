import { describe, expect, it } from "vitest";
import { compileTailwind } from "@/lib/tailwind-css.test.helper";

/** The brace depth at `index` of `css`: 0 means outside every block (and every @layer). */
function depthAt(css: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return depth;
}

describe("text fields on touch screens", () => {
  it("show 16px, unlayered, so iOS Safari does not zoom in on focus over text-sm", async () => {
    const css = await compileTailwind(["text-sm"]);
    const media = css.indexOf("@media (pointer: coarse)");
    expect(media).toBeGreaterThanOrEqual(0);
    // Outside @layer: an unlayered rule beats the utilities layer's .text-sm.
    expect(depthAt(css, media)).toBe(0);
    const block = css.slice(media, css.indexOf("}", media));
    expect(block).toMatch(/input:not\(/);
    expect(block).toMatch(/textarea/);
    expect(block).toMatch(/select/);
    expect(block).toMatch(/font-size:\s*16px/);
    // The utility it has to beat is layered.
    expect(depthAt(css, css.indexOf(".text-sm"))).toBeGreaterThan(0);
  });
});
