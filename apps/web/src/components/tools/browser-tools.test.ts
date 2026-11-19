import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The browser tools (v1.1 "Tools": PDF and QR) send nothing anywhere. The page's promise
 * is "Your files and entries are not transmitted", so what the client bundle of a tool
 * is made of is pinned here: starting at each tool component, every local module it
 * reaches (through `@/` and relative imports) is free of a server action ("use server"),
 * of the CMS client and the session layer, and of any call that stores or sends
 * (fetch, XMLHttpRequest, sendBeacon, sockets, web storage, cookies). The page modules
 * import the viewer to apply the read gate and nothing that moves data. The libraries
 * load lazily: pdf-lib and qrcode are reached by a dynamic import() only.
 */
const SRC = join(__dirname, "..", "..");

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;
  return (
    [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(
      existsSync,
    ) ?? null
  );
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const specifiersOf = (text: string) => [...text.matchAll(SPECIFIER)].map((match) => match[1]!);

/** Every file reachable from `entry` through local imports, keyed by its path under src. */
function closure(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const name = relative(SRC, file).replaceAll("\\", "/");
    if (files.has(name)) continue;
    const text = readFileSync(file, "utf8");
    files.set(name, text);
    for (const specifier of specifiersOf(text)) {
      const local = resolveLocal(file, specifier);
      if (local) queue.push(local);
    }
  }
  return files;
}

/** Each tool component, with modules its bundle must contain (the walk found the real graph). */
const TOOLS: Array<[entry: string, reaches: string[]]> = [
  [
    "components/tools/pdf-tool.tsx",
    ["lib/pdf-tools.ts", "lib/browser-download.ts", "components/secrets/clean-document.ts"],
  ],
];
const PAGES = ["app/(app)/tools/pdf/page.tsx"];

const BANNED_MODULES =
  /^(@\/lib\/(strapi|api|session|viewer|auth|loaders)|@\/auth|next\/headers|next-auth|server-only)(\/|$)/;
const BANNED_CALLS =
  /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bWebSocket\b|\bEventSource\b|localStorage|sessionStorage|indexedDB|document\.cookie/;

describe.each(TOOLS)("the client bundle of %s", (entry, reaches) => {
  const files = closure(entry);

  it("is walked through its local imports (the walk works)", () => {
    expect([...files.keys()]).toEqual(expect.arrayContaining([entry, ...reaches]));
  });

  it("holds no server action and imports no CMS client or session layer", () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/["']use server["']/);
      for (const specifier of specifiersOf(text)) {
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(BANNED_MODULES);
      }
    }
  });

  it("stores and sends nothing: no fetch, request object, beacon, socket, storage or cookie", () => {
    for (const [name, text] of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, name).not.toMatch(BANNED_CALLS);
    }
  });
});

describe.each(PAGES)("the page module %s", (entry) => {
  it("imports the read gate and the tool, no action and no data client", () => {
    const text = readFileSync(join(SRC, entry), "utf8");
    expect(text).not.toMatch(/["']use server["']/);
    const local = specifiersOf(text).filter((specifier) => specifier.startsWith("@/"));
    expect(local.sort()).toEqual(
      [
        "@/components/page-header",
        "@/components/section-unavailable",
        "@/components/tools/pdf-tool",
        "@/lib/roles",
        "@/lib/viewer",
      ].sort(),
    );
    expect(text).not.toMatch(BANNED_CALLS);
  });
});

describe("where the libraries load", () => {
  const all: Array<{ name: string; text: string }> = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.(tsx?|helper\.ts)$/.test(entry.name)) {
        all.push({
          name: relative(SRC, path).replaceAll("\\", "/"),
          text: readFileSync(path, "utf8"),
        });
      }
    }
  })(SRC);

  it("loads pdf-lib by a dynamic import() in lib/pdf-tools.ts only, never statically", () => {
    const using = all.filter((file) => file.text.includes("@cantoo/pdf-lib"));
    expect(using.map((file) => file.name)).toEqual(["lib/pdf-tools.ts"]);
    expect(using[0]!.text).not.toMatch(/\bfrom\s+["']@cantoo\/pdf-lib["']/);
    expect(using[0]!.text).toMatch(/import\(\s*"@cantoo\/pdf-lib"\s*\)/);
  });
});
