import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The browser tools (v1.1 "Tools": PDF and QR) send nothing anywhere. The page's promise
 * is "Your files and entries are not transmitted", so what the client bundle of a tool
 * is made of is pinned here: starting at each tool component, every local module it
 * reaches (through `@/` and relative imports, static, dynamic, side-effect and `require`
 * alike) is free of a server action ("use server"), of the CMS client and the session
 * layer, and of every channel data could leave through: requests, storage, the URL and
 * history, images and other loaded elements, forms and other contexts. The page modules
 * import the viewer to apply the read gate and nothing that moves data. The libraries
 * load lazily: pdf-lib and qrcode are reached by a dynamic import() only.
 *
 * This is a SMOKE test, not proof: patterns over the source text, which strings, aliases and
 * computed access can fool, and not the built bundle. It catches the ordinary ways code
 * reaches a network, the URL or the page. The proof is the built app's chunks (the release's
 * bundle check) and the request listener in e2e/tools.spec.ts.
 */
const SRC = join(__dirname, "..", "..");

/**
 * Code without what does not run: comments (a word in a comment is no import and no call,
 * trailing ones included) and type-only imports and exports, which are erased.
 */
const codeOf = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\b(?:import|export)\s+type\b[^;]*;/g, "");

/** `from "x"`, a side-effect `import "x"` and `require("x")`. */
const STATIC_IMPORT =
  /\b(?:from|import)\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const staticSpecifiers = (code: string) =>
  [...code.matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2]!);
const dynamicSpecifiers = (code: string) =>
  [...code.matchAll(DYNAMIC_IMPORT)].map((match) => match[1]!);
const specifiersOf = (code: string) => [...staticSpecifiers(code), ...dynamicSpecifiers(code)];
const isLibrary = (specifier: string, library: string) =>
  specifier === library || specifier.startsWith(`${library}/`);

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

const nameOf = (file: string) => relative(SRC, file).replaceAll("\\", "/");

/** Every non-test source file of the web app: its path under src and its code. */
const SOURCES: Array<{ name: string; code: string }> = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.(tsx?|helper\.ts)$/.test(entry.name)) {
      SOURCES.push({ name: nameOf(path), code: codeOf(readFileSync(path, "utf8")) });
    }
  }
})(SRC);

/** Every file reachable from `entry` through local imports of any kind: its path and code. */
function closure(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(nameOf(file))) continue;
    const code = codeOf(readFileSync(file, "utf8"));
    files.set(nameOf(file), code);
    for (const specifier of specifiersOf(code)) {
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
  [
    "components/tools/qr-tool.tsx",
    ["lib/qr-code.ts", "lib/browser-download.ts", "components/secrets/clean-document.ts"],
  ],
];
const PAGES: Array<[page: string, tool: string]> = [
  ["app/(app)/tools/pdf/page.tsx", "@/components/tools/pdf-tool"],
  ["app/(app)/tools/qr/page.tsx", "@/components/tools/qr-tool"],
];

const BANNED_MODULES =
  /^(@\/lib\/(strapi|api|session|viewer|auth|loaders)|@\/auth|next\/(headers|navigation|link|router)|next-auth|server-only)(\/|$)/;

/** The ways data could leave the page, as code patterns. */
const CHANNELS: Record<string, RegExp> = {
  request: /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bWebSocket\b|\bEventSource\b/,
  storage: /localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore/,
  url: /\blocation\s*(?:\.\s*(?:href|search|hash)\s*=(?!=)|\.\s*(?:assign|replace)\s*\(|=(?![=>]))|\bhistory\s*\.\s*(?:push|replace)State|\bwindow\s*\.\s*open\b|\bredirect\s*\(/,
  image:
    /\bnew\s+(?:Image|Audio)\s*\(|createElement\(\s*["'](?:img|script|iframe|link|form|object|embed|video|audio|source)["']|\.src(?:set)?\s*=/,
  form: /\bFormData\b|\.submit\s*\(|\brequestSubmit\b|<form\b[^>]*\b(?:action|method)\s*=|\bformAction\b/,
  context: /\bpostMessage\b|new\s+(?:Shared)?Worker\s*\(|BroadcastChannel|serviceWorker/,
  // Elements that load or navigate: JSX iframes and scripts, `srcSet`, `setAttribute("src"`,
  // anchors with an href. (The one <img> and the download's `link.href` are checked apart.)
  element:
    /<(?:iframe|script|embed|video|audio|frame)\b|\bsrcSet\s*=|\bsetAttribute\(\s*["'](?:src|srcset|href|action|data|formaction)["']|<a\b[^>]*\bhref\s*=/,
  anchor: /\.href\s*=(?!=)/,
};

/** The one place that sets an anchor's href: the download's object URL (see below). */
const DOWNLOAD = "lib/browser-download.ts";

/** The <img> tags in `code` that do not show the code's own data URL. */
const foreignImages = (code: string) =>
  (code.match(/<img\b[^>]*>/g) ?? []).filter((tag) => !/\bsrc=\{made\.png\}/.test(tag));

describe("the guards themselves", () => {
  it("read every way of importing a module", () => {
    const code = [
      'import "qrcode";',
      'import QR from "qrcode";',
      'import type { X } from "qrcode";',
      'import {\n  a,\n  b,\n} from "qrcode";',
      'export * from "qrcode";',
      'const q = require("qrcode");',
      'const d = await import("qrcode");',
    ].join("\n");
    expect(staticSpecifiers(code)).toEqual(Array(6).fill("qrcode"));
    expect(dynamicSpecifiers(code)).toEqual(["qrcode"]);
    expect(isLibrary("qrcode/lib/browser", "qrcode")).toBe(true);
    expect(isLibrary("qrcodes", "qrcode")).toBe(false);
  });

  it("ignore what does not run: comments, trailing ones too, and type-only imports and exports", () => {
    const code = [
      '// import "qrcode"',
      '/* from "qrcode" */',
      'const a = 1; // fetch(url) and import "qrcode"',
      'import type { X } from "qrcode";',
      'import type {\n  Y,\n  Z,\n} from "@cantoo/pdf-lib";',
      'export type { X } from "qrcode";',
      'const link = "https://example.org/a"; // a URL is not a comment',
    ].join("\n");
    const run = codeOf(code);
    expect(staticSpecifiers(run)).toEqual([]);
    expect(run).not.toMatch(CHANNELS.request!);
    expect(run).toContain("https://example.org/a");
  });

  it("still see a runtime import beside a type-only one", () => {
    expect(staticSpecifiers(codeOf('import { type X, load } from "qrcode";'))).toEqual(["qrcode"]);
  });

  it.each([
    ["request", "await fetch(url)"],
    ["request", "new XMLHttpRequest()"],
    ["request", "navigator.sendBeacon(url, data)"],
    ["request", "new WebSocket(url)"],
    ["storage", "localStorage.setItem(a, b)"],
    ["storage", "document.cookie = value"],
    ["url", "window.location.href = target"],
    ["url", "location.assign(target)"],
    ["url", "location = target"],
    ["url", "location.hash = target"],
    ["url", "location.replace(target)"],
    ["url", "history.pushState({}, '', target)"],
    ["url", "window.open(target)"],
    ["image", "new Image().src = target"],
    ["image", 'document.createElement("img")'],
    ["image", 'document.createElement("script")'],
    ["image", "element.src = target"],
    ["form", "new FormData(form)"],
    ["form", "form.submit()"],
    ["form", '<form action="/x" onSubmit={go}>'],
    ["context", "worker.postMessage(data)"],
    ["context", "new Worker(url)"],
    ["element", "<iframe src={target} />"],
    ["element", "<iframe\n  title={x}\n  src={target}\n/>"],
    ["element", "<img srcSet={`${target} 1x`} alt={x} />"],
    ["element", "<script src={target} />"],
    ["element", 'node.setAttribute("src", target)'],
    ["element", "node.setAttribute('href', target)"],
    ["element", "<a href={target}>go</a>"],
    ["anchor", "link.href = target"],
  ])("catch a %s channel: %s", (channel, code) => {
    expect(code).toMatch(CHANNELS[channel]!);
  });

  it("see an <img> that does not show the code's own data URL", () => {
    expect(foreignImages("<img src={target} alt={x} />")).toHaveLength(1);
    expect(foreignImages('<img src="https://example.org/x.png" alt="" />')).toHaveLength(1);
    expect(foreignImages("<img\n  src={made.png}\n  alt={x}\n/>")).toHaveLength(0);
  });

  it.each([
    "window.location.reload()",
    "<form onSubmit={go} noValidate className={x}>",
    'document.createElement("a")',
    "<img src={made.png} alt={t('alt')} />",
    'if (location === "x") {}',
    "const abbr = <abbr title={x}>a</abbr>;",
    "const set = new Set<number>();",
    "const href = new URL(target).href;",
    "if (link.href === wanted) {}",
    "if (window.location.href !== wanted || location.href == other) {}",
    "const same = location.hash === wanted;",
    "const find = (location) => location.id;",
  ])("leave what the tools do alone: %s", (code) => {
    for (const [channel, pattern] of Object.entries(CHANNELS)) {
      expect(code, channel).not.toMatch(pattern);
    }
  });
});

describe.each(TOOLS)("the client bundle of %s", (entry, reaches) => {
  const files = closure(entry);

  it("is walked through its local imports (the walk works)", () => {
    expect([...files.keys()]).toEqual(expect.arrayContaining([entry, ...reaches]));
  });

  it("holds no server action and imports no CMS client, session layer or navigation", () => {
    for (const [name, code] of files) {
      expect(code, name).not.toMatch(/["']use server["']/);
      for (const specifier of specifiersOf(code)) {
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(BANNED_MODULES);
      }
    }
  });

  it("sends and stores nothing, in no channel", () => {
    for (const [name, code] of files) {
      for (const [channel, pattern] of Object.entries(CHANNELS)) {
        if (channel === "anchor" && name === DOWNLOAD) continue;
        expect(code, `${name}: ${channel}`).not.toMatch(pattern);
      }
    }
  });

  it("loads no remote image: an <img> shows the code's own data URL", () => {
    for (const [name, code] of files) expect(foreignImages(code), name).toEqual([]);
  });

  it("reaches neither library statically (they load by a dynamic import())", () => {
    for (const [name, code] of files) {
      for (const specifier of staticSpecifiers(code)) {
        expect(isLibrary(specifier, "@cantoo/pdf-lib"), `${name} imports ${specifier}`).toBe(false);
        expect(isLibrary(specifier, "qrcode"), `${name} imports ${specifier}`).toBe(false);
      }
    }
  });
});

describe.each(PAGES)("the page module %s", (entry, tool) => {
  it("imports the read gate and the tool, no action and no data client", () => {
    const code = SOURCES.find((file) => file.name === entry)!.code;
    expect(code).not.toMatch(/["']use server["']/);
    const local = staticSpecifiers(code).filter((specifier) => specifier.startsWith("@/"));
    expect(local.sort()).toEqual(
      [
        "@/components/page-header",
        "@/components/section-unavailable",
        tool,
        "@/lib/roles",
        "@/lib/viewer",
      ].sort(),
    );
    for (const pattern of Object.values(CHANNELS)) expect(code).not.toMatch(pattern);
  });
});

describe("where the libraries load", () => {
  it.each([
    ["@cantoo/pdf-lib", "lib/pdf-tools.ts", []],
    ["qrcode", "lib/qr-code.ts", ["app/mfa/setup/page.tsx"]],
  ])(
    "%s: loaded by a dynamic import() in %s only; static importers: %j",
    (library, home, staticUsers) => {
      const names = (kind: typeof staticSpecifiers) =>
        SOURCES.filter((file) => kind(file.code).some((s) => isLibrary(s, library))).map(
          (file) => file.name,
        );
      expect(names(dynamicSpecifiers)).toEqual([home]);
      expect(names(staticSpecifiers)).toEqual(staticUsers);
    },
  );

  it("qrcode has a browser build the bundlers pick for the client (no pngjs, no fs)", () => {
    const manifest = JSON.parse(
      readFileSync(join(SRC, "..", "node_modules", "qrcode", "package.json"), "utf8"),
    ) as { browser: Record<string, string | false> };
    expect(manifest.browser["./lib/index.js"]).toBe("./lib/browser.js");
    expect(manifest.browser.fs).toBe(false);
  });
});

describe("the download", () => {
  it("sets an anchor's href to its own object URL, and to nothing else", () => {
    const code = SOURCES.find((file) => file.name === DOWNLOAD)!.code;
    expect(code.match(/\.href\s*=[^;]*;/g)).toEqual([".href = url;"]);
    expect(code).toMatch(/const url = URL\.createObjectURL\(blob\);/);
  });
});
