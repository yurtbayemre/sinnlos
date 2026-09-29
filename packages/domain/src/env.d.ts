/**
 * The one host API the package uses beyond ECMAScript: the WHATWG URL
 * parser, a global in Node and in every browser. Declared here, as far as
 * the package uses it, instead of loading lib.dom or @types/node, so the
 * compiler refuses browser-only (window, document) and Node-only (process,
 * Buffer) APIs in package code (tsconfig.json). The declarations are not
 * part of the emitted .d.ts files: no exported signature mentions URL.
 */
declare class URL {
  constructor(url: string, base?: string);
  readonly protocol: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

declare class URLSearchParams {
  get(name: string): string | null;
}
