import type { AuthoringFieldCode } from "./authoring/codes.js";

/**
 * Processes (BPMN, v1.1 "Tools"): a title, a plain-text summary (the text
 * alternative of the diagram, so it is required) and the diagram as BPMN 2.0
 * XML. The cms stores the XML, the browser (bpmn-js) parses and draws it, so
 * this is a STORAGE guard, not a sanitizer: size, XML-legal characters, the
 * BPMN root and no DTD. It is a bounded string scan, not an XML parse.
 * shortcut: a well-formed check (unclosed tags) is left to the browser, where
 * an unparseable diagram shows an error panel with the download; add a real
 * parser here only if the cms ever has to read the diagram itself.
 *
 * The one thing it does check inside the XML is PAINT: bpmn-js copies the
 * color attributes of the diagram interchange into SVG `fill` and `stroke`,
 * and Chromium requests the address of a `url(...)` there, in the viewer and
 * again when an exported .svg is opened as a file (checked against bpmn-js
 * 18.33.0 in Chromium). So a color must be a plain one (hex, a color name,
 * rgb() or hsl()), here and in the browser before anything is drawn
 * (hasUnsafePaint). Labels, documentation and unknown attributes need no check:
 * bpmn-js sets labels as text and ignores what it does not know.
 *
 * One rule for every writer: the cms lifecycle and the authoring allowlist
 * call processDiagramCode, the web forms run it first for precise messages.
 */

export const MAX_PROCESS_SUMMARY = 2000;
/** Characters of the diagram (UTF-16 units, like `string.length`). */
export const MAX_PROCESS_DIAGRAM_CHARS = 300_000;
/** UTF-8 bytes of `JSON.stringify(diagram)`: what the field costs in a request body. */
export const MAX_PROCESS_DIAGRAM_BYTES = 700 * 1024;
/**
 * The whole serialized authoring request, checked in the web before it is
 * sent (koa-body refuses a JSON body above 1 MiB = 1 048 576 bytes).
 */
export const MAX_PROCESS_REQUEST_BYTES = 1_000_000;
/** The BPMN 2.0 model namespace the root element must be in. */
export const BPMN_MODEL_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/MODEL";

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The attributes bpmn-js turns into paint (BpmnRenderUtil): bioc:fill, bioc:stroke,
 * color:background-color, color:border-color and color:color. Matched by their local
 * name (after the last colon), because a document chooses its own namespace prefix:
 * zz:stroke, and even the empty prefix of `xmlns:="…biocolor…"` + `:fill`, which
 * bpmn-moddle 10.3.1 accepts as bioc:fill. A namespace declaration
 * (xmlns:color="http://...") is no paint.
 */
const PAINT_ATTRIBUTE =
  /(?:^|\s)(?!xmlns:)(?:[^\s=<>"'/]*:)?(?:fill|stroke|background-color|border-color|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** A plain color: empty, hex, a name, or rgb()/hsl() of numbers; no escapes, no url(). */
const PLAIN_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(?:rgb|hsl)a?\([0-9., %/]{1,40}\))?$/;

/** Whether a paint attribute of the diagram holds anything but a plain color. */
export function hasUnsafePaint(xml: string): boolean {
  for (const match of xml.matchAll(PAINT_ATTRIBUTE)) {
    if (!PLAIN_COLOR.test(match[1] ?? match[2] ?? "")) return true;
  }
  return false;
}

/** The summary: non-blank, at most MAX_PROCESS_SUMMARY characters. */
export function processSummaryCode(value: unknown): AuthoringFieldCode | null {
  if (value === null || value === undefined) return "required";
  if (!isString(value)) return "invalid";
  if (value.trim() === "") return "required";
  return value.length > MAX_PROCESS_SUMMARY ? "tooLong" : null;
}

/** The UTF-8 byte length of what `JSON.stringify(value)` writes for a string. */
export function processDiagramJsonBytes(diagram: string): number {
  return new TextEncoder().encode(JSON.stringify(diagram)).length;
}

/**
 * A character XML 1.0 forbids: C0 controls but TAB, LF and CR, a lone
 * surrogate, U+FFFE and U+FFFF. One pass over the code units.
 */
export function hasXmlIllegalChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20) {
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    } else if (code === 0xfffe || code === 0xffff) {
      return true;
    }
  }
  return false;
}

/** Skips whitespace, `<?...?>` and `<!--...-->` before the root; the index of the root's `<`, or -1. */
function rootStart(xml: string): number {
  let i = 0;
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i] as string)) i++;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) return -1;
      i = end + 2;
    } else if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) return -1;
      i = end + 3;
    } else {
      return xml.startsWith("<", i) ? i : -1;
    }
  }
}

const ROOT_TAG =
  /^<(?:([A-Za-z_][\w.-]*):)?definitions((?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*\/?>/;
const ATTRIBUTE = /([^\s=<>/"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

/** Whether the root element is `definitions` in the BPMN MODEL namespace. */
function hasBpmnRoot(xml: string): boolean {
  const start = rootStart(xml);
  if (start < 0) return false;
  const tag = ROOT_TAG.exec(xml.slice(start, start + 20_000));
  if (!tag) return false;
  const declared = tag[1] ? `xmlns:${tag[1]}` : "xmlns";
  for (const attribute of (tag[2] ?? "").matchAll(ATTRIBUTE)) {
    if (attribute[1] === declared) return (attribute[2] ?? attribute[3]) === BPMN_MODEL_NAMESPACE;
  }
  return false;
}

/**
 * The diagram: a string of at most MAX_PROCESS_DIAGRAM_CHARS characters with
 * only XML-legal characters, JSON-serialised at most MAX_PROCESS_DIAGRAM_BYTES
 * bytes, a BPMN `definitions` root, no `<!DOCTYPE` and no `<!ENTITY`, plain colors only.
 * `tooLong` for the two size rules, `required` for blank, `invalid` otherwise.
 */
export function processDiagramCode(value: unknown): AuthoringFieldCode | null {
  if (value === null || value === undefined) return "required";
  if (!isString(value)) return "invalid";
  if (value.trim() === "") return "required";
  if (value.length > MAX_PROCESS_DIAGRAM_CHARS) return "tooLong";
  if (hasXmlIllegalChar(value)) return "invalid";
  if (processDiagramJsonBytes(value) > MAX_PROCESS_DIAGRAM_BYTES) return "tooLong";
  if (/<!(?:DOCTYPE|ENTITY)/i.test(value) || hasUnsafePaint(value)) return "invalid";
  return hasBpmnRoot(value) ? null : "invalid";
}
