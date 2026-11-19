import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The bpmn.io license (bpmn-js 18.33.0: MIT plus a watermark clause): the "powered by
 * bpmn.io" logo bpmn-js draws into every viewer and modeler (`.bjs-powered-by`, inline
 * styles: bottom right, z-index 100) must stay fully visible and not be overlapped,
 * hidden or changed. Nothing of ours may style or cover it, and the library and its
 * stylesheets load in the two client wrappers only, never in a server render or on a
 * page that shows no diagram. The browser side of the same promise (the element is
 * there, visible and on top) is e2e/processes.spec.ts.
 */
const SRC = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.(tsx?|helper\.ts)$/.test(entry.name)
      ? [path]
      : [];
  });
}

const ALL = sources(SRC).map((path) => ({
  name: relative(SRC, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));
const importing = (needle: string) =>
  ALL.filter((file) => file.text.includes(needle)).map((file) => file.name);

describe("the bpmn.io watermark", () => {
  it("is never styled, hidden or addressed by any of our sources", () => {
    expect(importing("bjs-powered-by")).toEqual([]);
    // Nor any other diagram-js or bpmn-js class in our own stylesheets or class names.
    const styles = ALL.filter((file) => file.name.endsWith(".css"));
    for (const file of styles) {
      expect(file.text, file.name).not.toMatch(/\.(bjs|djs|bpmn)-/);
    }
  });

  it("is drawn by the two wrappers only, which hold the canvas in a plain box with nothing laid over it", () => {
    for (const name of ["processes/process-viewer.tsx", "processes/diagram-modeler.tsx"]) {
      const text = ALL.find((file) => file.name === `components/${name}`)?.text ?? "";
      expect(text, name).toContain("bpmn.io");
      // Nothing is positioned inside the container ref; the canvas element is the container itself.
      expect(text, name).not.toMatch(/absolute|fixed|z-\[?\d/);
    }
  });
});

describe("where bpmn-js loads", () => {
  it("imports the library and its stylesheets in the two client wrappers only", () => {
    const wrappers = [
      "components/processes/diagram-modeler.tsx",
      "components/processes/process-viewer.tsx",
    ];
    expect(importing('from "bpmn-js').sort()).toEqual(wrappers);
    expect(importing('"bpmn-js/dist/assets/').sort()).toEqual(wrappers);
    for (const sheet of ["diagram-js.css", "bpmn-js.css", "bpmn-font/css/bpmn.css"]) {
      expect(importing(`bpmn-js/dist/assets/${sheet}`).sort(), sheet).toEqual(wrappers);
    }
  });

  it("reaches the wrappers through next/dynamic with ssr: false, from client components", () => {
    for (const [lazy, chunk] of [
      ["process-viewer-lazy.tsx", "./process-viewer"],
      ["diagram-modeler-lazy.tsx", "./diagram-modeler"],
    ]) {
      const text = ALL.find((file) => file.name === `components/processes/${lazy}`)?.text ?? "";
      expect(text, lazy).toMatch(/^"use client";/);
      expect(text, lazy).toContain(`import("${chunk}")`);
      expect(text, lazy).toMatch(/ssr: false/);
    }
    // Only the lazy wrappers import the chunks: no server component pulls bpmn-js in statically.
    expect(importing('from "./process-viewer"')).toEqual([]);
    expect(importing('from "./diagram-modeler"')).toEqual([]);
    expect(importing('processes/process-viewer"').sort()).toEqual([]);
    expect(importing('processes/diagram-modeler"').sort()).toEqual([
      "components/manage/process-editor.tsx",
    ]);
  });
});

describe("the modeler's configuration", () => {
  it("binds no keyboard element: diagram-js 15 binds the canvas SVG itself and logs an error for bindTo", () => {
    const text = ALL.find((file) => file.name === "components/processes/diagram-modeler.tsx")?.text;
    expect(text).toBeDefined();
    expect(text).not.toMatch(/bindTo/);
    expect(text).toMatch(/new Modeler\(\{ container: element \}\)/);
  });
});
