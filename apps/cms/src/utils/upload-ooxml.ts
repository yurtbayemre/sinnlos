/**
 * The Office Open XML rule (deep-dive decision 06 §E1, owner amendment 2,
 * amendment rows A4 and A6; batch 16 lane 16A). One rule for DOCX, XLSX and
 * PPTX; a file is one of them only when every step passes:
 *   1. CONTAINER: a zip in the one accepted layout, within the parser
 *      limits (utils/upload-zip.ts).
 *   2. `[Content_Types].xml` at the root, stored or deflated, at most
 *      64 KiB compressed and 256 KiB inflated (CRC-32 checked), UTF-8 with
 *      an optional BOM, read by the bounded tokenizer below for a FIXED
 *      SUBSET of XML. Neither a general XML parser (Node has none built in)
 *      nor a string scan (which does not see what a parser sees: character
 *      references such as `macro&#69;nabled` decode to `macroEnabled`):
 *        - allowed: an optional XML declaration (version 1.0; encoding
 *          UTF-8 and standalone if named), exactly one root `Types` whose
 *          only attribute is the OPC default namespace, and only `Default`
 *          and `Override` children, each empty or closed at once, with
 *          whitespace between elements;
 *        - refused: a DOCTYPE (so no entity is declared, expanded or
 *          fetched), any other processing instruction, comments, CDATA,
 *          text, prefixed names, other elements or attributes, a repeated
 *          attribute;
 *        - attribute values are decoded before any comparison (the five
 *          predefined entities, decimal and hexadecimal character
 *          references); an unknown or malformed reference refuses, and so
 *          does a decoded value holding whitespace or a control character;
 *        - `Default` carries exactly `Extension` and `ContentType`,
 *          `Override` exactly `PartName` and `ContentType`; two `Default`s
 *          for one extension, or two `Override`s for one part name
 *          (ASCII-case-insensitive), refuse.
 *   3. EXACTLY ONE MAIN PART: exactly one decoded content type ends in
 *      `.main+xml` or `.main`; it is one of the three of the table
 *      (@sinnlos/domain OFFICE_FORMAT_SPECS) on an `Override` whose part
 *      lies in that format's folder (`/word/`, `/xl/`, `/ppt/`), and the
 *      part exists in the directory.
 *      The decision's conventional names (`/word/document.xml`, ...) are
 *      relaxed to the folder, as §E1 provides for a producer that names the
 *      main part otherwise: the OpenXML SDK writes `/word/document2.xml`.
 *      Office finds the main part through `_rels/.rels`, so the name proves
 *      nothing either way; the content type is the check.
 *   4. NO MACROS: no decoded content type contains `macroEnabled`,
 *      `vbaProject` or `macrosheet` (case-insensitively); no entry in any
 *      directory is named `vbaProject.bin`, `vbaProjectSignature.bin`,
 *      `vbaProjectSignatureAgile.bin`, `vbaProjectSignatureV3.bin` or
 *      `vbaData.xml`; no entry lies under `xl/macrosheets/` (Excel 4.0
 *      macro sheets need no VBA project).
 * So every macro-enabled variant (.docm, .dotm, .xlsm, .xltm, .xlam, .pptm,
 * .potm, .ppsm) is refused, renamed or not; .xlsb by steps 3 and 4;
 * templates (.dotx, .xltx, .potx) and slideshows (.ppsx) by step 3.
 *
 * What this proves, and what not, is in docs/security.md ("Uploads").
 */
import { OFFICE_FORMATS, OFFICE_FORMAT_SPECS, type OfficeFormat } from "@sinnlos/domain";

import {
  ZipRefusal,
  foldName,
  readEntry,
  readZipLayout,
  type RandomAccessFile,
  type ZipLayout,
} from "./upload-zip";

export const CONTENT_TYPES_NAME = "[Content_Types].xml";
export const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
export const CONTENT_TYPES_LIMITS = { maxCompressed: 64 * 1024, maxInflated: 256 * 1024 } as const;

export interface ContentTypeDefault {
  extension: string;
  contentType: string;
}

export interface ContentTypeOverride {
  partName: string;
  contentType: string;
}

export interface ContentTypes {
  defaults: ContentTypeDefault[];
  overrides: ContentTypeOverride[];
}

const refuse = (reason: string): never => {
  throw new ZipRefusal(reason);
};

const BOM = [0xef, 0xbb, 0xbf];
const NAME = /^[A-Za-z]+$/;
const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};
/** Whitespace or a control character, after decoding. */
const FORBIDDEN_IN_VALUE = /[\s\p{Cc}]/u;

const isSpace = (char: string | undefined): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

/** A legal XML 1.0 character (refused otherwise, before the whitespace check). */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Decodes the predefined entities and character references of an attribute value. */
export function decodeAttributeValue(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "<") refuse("< in an attribute value");
    if (char !== "&") {
      out += char;
      continue;
    }
    const end = raw.indexOf(";", i);
    if (end < 0 || end - i > 12) refuse("malformed reference");
    const body = raw.slice(i + 1, end);
    let decoded: string;
    if (body.startsWith("#x")) {
      if (!/^#x[0-9A-Fa-f]{1,6}$/.test(body)) refuse("malformed character reference");
      const code = Number.parseInt(body.slice(2), 16);
      if (!isXmlChar(code)) refuse("character reference to a non-character");
      decoded = String.fromCodePoint(code);
    } else if (body.startsWith("#")) {
      if (!/^#[0-9]{1,7}$/.test(body)) refuse("malformed character reference");
      const code = Number.parseInt(body.slice(1), 10);
      if (!isXmlChar(code)) refuse("character reference to a non-character");
      decoded = String.fromCodePoint(code);
    } else {
      decoded = PREDEFINED[body] ?? refuse(`unknown entity &${body};`);
    }
    out += decoded;
    i = end;
  }
  return out;
}

/** A cursor over the decoded text. */
class Cursor {
  at = 0;
  constructor(readonly text: string) {}

  get done(): boolean {
    return this.at >= this.text.length;
  }

  peek(offset = 0): string | undefined {
    return this.text[this.at + offset];
  }

  startsWith(literal: string): boolean {
    return this.text.startsWith(literal, this.at);
  }

  expect(literal: string): void {
    if (!this.startsWith(literal)) refuse(`expected ${literal}`);
    this.at += literal.length;
  }

  /** Skips whitespace; answers whether there was any. */
  skipSpace(): boolean {
    const start = this.at;
    while (isSpace(this.peek())) this.at += 1;
    return this.at > start;
  }

  /** A name: letters only (no prefix, no colon). */
  name(): string {
    const start = this.at;
    while (!this.done && /[^\s=/>"'<?]/.test(this.text[this.at])) this.at += 1;
    const name = this.text.slice(start, this.at);
    if (!NAME.test(name)) refuse(`name ${JSON.stringify(name)} outside the subset`);
    return name;
  }

  /** `S? = S? "value"` (or single quotes): the raw value. */
  quotedValue(): string {
    this.skipSpace();
    this.expect("=");
    this.skipSpace();
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") refuse("unquoted attribute value");
    const end = this.text.indexOf(quote as string, this.at + 1);
    if (end < 0) refuse("unterminated attribute value");
    const raw = this.text.slice(this.at + 1, end);
    this.at = end + 1;
    return raw;
  }
}

/** The optional XML declaration: version 1.0, then encoding UTF-8 and standalone if named. */
function parseDeclaration(cursor: Cursor): void {
  if (!cursor.startsWith("<?")) return;
  cursor.expect("<?xml");
  if (!cursor.skipSpace()) refuse("processing instruction");
  const seen: string[] = [];
  const order = ["version", "encoding", "standalone"];
  while (!cursor.startsWith("?>")) {
    const name = cursor.name();
    const value = decodeAttributeValue(cursor.quotedValue());
    const index = order.indexOf(name);
    if (index < 0 || seen.some((prior) => order.indexOf(prior) >= index)) {
      refuse("XML declaration outside the subset");
    }
    seen.push(name);
    if (name === "version" && value !== "1.0") refuse("XML version");
    if (name === "encoding" && value.toLowerCase() !== "utf-8") refuse("XML encoding");
    if (name === "standalone" && value !== "yes" && value !== "no") refuse("XML standalone");
    const hadSpace = cursor.skipSpace();
    if (!hadSpace && !cursor.startsWith("?>")) refuse("XML declaration outside the subset");
  }
  if (seen[0] !== "version") refuse("XML declaration without a version");
  cursor.expect("?>");
}

interface Element {
  name: string;
  attributes: Map<string, string>;
  /** `<x/>`, or `<x>` (content follows). */
  selfClosing: boolean;
}

/** A start tag at the cursor (`<` already checked): name, decoded attributes. */
function parseStartTag(cursor: Cursor): Element {
  cursor.expect("<");
  const name = cursor.name();
  const attributes = new Map<string, string>();
  for (;;) {
    const hadSpace = cursor.skipSpace();
    if (cursor.startsWith("/>")) {
      cursor.at += 2;
      return { name, attributes, selfClosing: true };
    }
    if (cursor.startsWith(">")) {
      cursor.at += 1;
      return { name, attributes, selfClosing: false };
    }
    if (!hadSpace) refuse("attributes without whitespace between them");
    const attribute = cursor.name();
    if (attributes.has(attribute)) refuse("repeated attribute");
    const value = decodeAttributeValue(cursor.quotedValue());
    if (FORBIDDEN_IN_VALUE.test(value)) refuse("whitespace or a control character in a value");
    attributes.set(attribute, value);
  }
}

function expectEndTag(cursor: Cursor, name: string): void {
  cursor.expect(`</${name}`);
  cursor.skipSpace();
  cursor.expect(">");
}

function exactlyAttributes(element: Element, names: readonly string[]): void {
  if (element.attributes.size !== names.length || names.some((n) => !element.attributes.has(n))) {
    refuse(`${element.name} attributes outside the subset`);
  }
}

/** `[Content_Types].xml` read as the fixed XML subset (step 2). */
export function parseContentTypes(bytes: Uint8Array): ContentTypes {
  const body = BOM.every((byte, i) => bytes[i] === byte) ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return refuse("not UTF-8");
  }
  const cursor = new Cursor(text);
  parseDeclaration(cursor);
  cursor.skipSpace();
  if (!cursor.startsWith("<") || cursor.startsWith("<!") || cursor.startsWith("<?")) {
    refuse("no root element (or a DOCTYPE, comment or processing instruction)");
  }
  const root = parseStartTag(cursor);
  if (root.name !== "Types") refuse("root is not Types");
  exactlyAttributes(root, ["xmlns"]);
  if (root.attributes.get("xmlns") !== CONTENT_TYPES_NAMESPACE) refuse("foreign namespace");

  const types: ContentTypes = { defaults: [], overrides: [] };
  const extensions = new Set<string>();
  const partNames = new Set<string>();
  if (!root.selfClosing) {
    for (;;) {
      cursor.skipSpace();
      if (cursor.startsWith("</")) {
        expectEndTag(cursor, "Types");
        break;
      }
      if (!cursor.startsWith("<") || cursor.startsWith("<!") || cursor.startsWith("<?")) {
        refuse("text, comment, CDATA or processing instruction inside Types");
      }
      const child = parseStartTag(cursor);
      if (!child.selfClosing) expectEndTag(cursor, child.name);
      if (child.name === "Default") {
        exactlyAttributes(child, ["Extension", "ContentType"]);
        const extension = child.attributes.get("Extension") as string;
        if (extensions.has(foldName(extension))) refuse("two Defaults for one extension");
        extensions.add(foldName(extension));
        types.defaults.push({
          extension,
          contentType: child.attributes.get("ContentType") as string,
        });
      } else if (child.name === "Override") {
        exactlyAttributes(child, ["PartName", "ContentType"]);
        const partName = child.attributes.get("PartName") as string;
        if (partNames.has(foldName(partName))) refuse("two Overrides for one part");
        partNames.add(foldName(partName));
        types.overrides.push({
          partName,
          contentType: child.attributes.get("ContentType") as string,
        });
      } else {
        refuse(`element ${child.name} inside Types`);
      }
    }
  }
  cursor.skipSpace();
  if (!cursor.done) refuse("content after the root element");
  return types;
}

const MAIN_TYPE = /\.main(\+xml)?$/i;
const MACRO_MARKERS = ["macroenabled", "vbaproject", "macrosheet"];
const VBA_PART_NAMES: ReadonlySet<string> = new Set([
  "vbaproject.bin",
  "vbaprojectsignature.bin",
  "vbaprojectsignatureagile.bin",
  "vbaprojectsignaturev3.bin",
  "vbadata.xml",
]);
const MACRO_SHEET_FOLDER = "xl/macrosheets/";

/** Steps 3 and 4 on a checked layout and its parsed `[Content_Types].xml`. */
export function officeFormatOf(layout: ZipLayout, types: ContentTypes): OfficeFormat {
  const contentTypes = [
    ...types.defaults.map((entry) => entry.contentType),
    ...types.overrides.map((entry) => entry.contentType),
  ];
  // Step 4: no macro carrier, declared or named.
  for (const contentType of contentTypes) {
    const folded = foldName(contentType);
    if (MACRO_MARKERS.some((marker) => folded.includes(marker))) refuse("macro content type");
  }
  for (const entry of layout.entries) {
    const folded = foldName(entry.name);
    if (VBA_PART_NAMES.has(folded.slice(folded.lastIndexOf("/") + 1))) refuse("VBA part");
    if (folded.startsWith(MACRO_SHEET_FOLDER)) refuse("Excel 4.0 macro sheet");
  }
  // Step 3: exactly one main part, of a format of the table, in its folder, present.
  if (contentTypes.filter((contentType) => MAIN_TYPE.test(contentType)).length !== 1) {
    refuse("not exactly one main content type");
  }
  const main = types.overrides.find((entry) => MAIN_TYPE.test(entry.contentType));
  if (!main) return refuse("the main content type is not on an Override");
  const format = OFFICE_FORMATS.find(
    (candidate) =>
      foldName(OFFICE_FORMAT_SPECS[candidate].mainContentType) === foldName(main.contentType),
  );
  if (!format) return refuse("main content type outside the table");
  const partName = foldName(main.partName);
  if (!partName.startsWith(`/${OFFICE_FORMAT_SPECS[format].folder}/`)) {
    refuse("main part outside its format's folder");
  }
  const part = layout.byName.get(partName.slice(1));
  if (!part || part.isDirectory) refuse("main part missing");
  return format;
}

/** The whole rule on a file that starts with a local header (steps 1-4). */
export async function sniffOfficeFormat(file: RandomAccessFile): Promise<OfficeFormat> {
  const layout = await readZipLayout(file);
  const entry = layout.byName.get(foldName(CONTENT_TYPES_NAME));
  if (!entry || entry.isDirectory) return refuse("no [Content_Types].xml");
  const types = parseContentTypes(await readEntry(file, entry, CONTENT_TYPES_LIMITS));
  return officeFormatOf(layout, types);
}
