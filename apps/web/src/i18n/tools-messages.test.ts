import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS_MESSAGE_NAMESPACES, withoutToolsMessages } from "./messages";

/**
 * The root layout leaves the `tools` and `processes` namespaces out of the client
 * provider (app/(app)/tools/layout.tsx gives the /tools subtree the whole catalog), so no
 * client component outside /tools may read them. This reads the source: every component
 * that calls useTranslations("tools…") or ("processes…"), and everything that imports it
 * (the importers, transitively), must sit under app/(app)/tools or be one of these four.
 */
const SRC = resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(SRC).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
const text = new Map(sources.map((file) => [file, readFileSync(file, "utf8")]));
const rel = (file: string) => relative(SRC, file).split("\\").join("/");

/** The source file an import specifier of `from` names, if it is one of ours. */
function resolveImport(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(from, "..", specifier)
      : undefined;
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(
    (candidate) => text.has(candidate) && existsSync(candidate),
  );
}

describe("the namespaces the root provider leaves out", () => {
  it("are read on the client by nothing outside /tools", () => {
    const readers = sources.filter((file) =>
      /useTranslations\(\s*["'`](tools|processes)[."'`]/.test(text.get(file) ?? ""),
    );
    expect(readers.map(rel).sort()).toEqual([
      "components/processes/process-viewer-lazy.tsx",
      "components/processes/process-viewer.tsx",
      "components/tools/pdf-tool.tsx",
      "components/tools/qr-tool.tsx",
    ]);

    const importedBy = new Map<string, Set<string>>();
    for (const file of sources) {
      for (const [, specifier] of (text.get(file) ?? "").matchAll(
        /(?:from|import\()\s*["']([^"']+)["']/g,
      )) {
        const target = resolveImport(file, specifier);
        if (target) importedBy.set(target, (importedBy.get(target) ?? new Set()).add(file));
      }
    }
    const reach = new Set(readers);
    for (const file of reach)
      for (const importer of importedBy.get(file) ?? []) reach.add(importer);
    // The walk does find the importers (else the check below would pass for nothing).
    expect([...reach].map(rel)).toEqual(
      expect.arrayContaining([
        "app/(app)/tools/pdf/page.tsx",
        "app/(app)/tools/qr/page.tsx",
        "app/(app)/tools/processes/[documentId]/page.tsx",
      ]),
    );
    const outside = [...reach].map(rel).filter((file) => !file.startsWith("app/(app)/tools/"));
    expect(outside.sort()).toEqual(readers.map(rel).sort());
  });

  it("cannot be read through a namespace-less hook either", () => {
    const loose = sources
      .filter((file) => /useMessages\(|useTranslations\(\s*\)/.test(text.get(file) ?? ""))
      .map(rel);
    expect(loose).toEqual([]);
  });
});

describe("withoutToolsMessages", () => {
  it("drops exactly the tools namespaces and leaves the rest, the original untouched", () => {
    expect(TOOLS_MESSAGE_NAMESPACES).toEqual(["tools", "processes"]);
    const catalog = {
      nav: { a: "A" },
      markdown: { b: "B" },
      tools: { c: "C" },
      processes: { d: "D" },
    };
    expect(withoutToolsMessages(catalog)).toEqual({ nav: { a: "A" }, markdown: { b: "B" } });
    expect(Object.keys(catalog)).toEqual(["nav", "markdown", "tools", "processes"]);
  });
});
