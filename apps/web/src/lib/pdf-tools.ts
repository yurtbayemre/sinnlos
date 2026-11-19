/**
 * The PDF tools of /tools/pdf (v1.1 "Tools"): merge, split by page ranges, rotate and
 * delete pages, entirely in the browser. No file, page range or result leaves the page:
 * this module imports no server action and no API client, and makes no request (pinned by
 * components/tools/browser-tools.test.ts).
 *
 * `@cantoo/pdf-lib` is loaded with a dynamic import() when a job runs, so it is in no
 * route's first-load JS. Every operation builds a NEW document from copied pages (merge,
 * split, rotate and delete alike), which drops what the document hangs on its catalog:
 * forms, bookmarks, layers, tags, signatures and document properties. A page copy follows
 * every reference of the page, so a kept page's annotations would pull the pages they
 * point to (a link to a deleted page, a form field with a widget on it) into the output:
 * every annotation except a web link (a Link with a URI action) is dropped, with the
 * page's other private hooks (`keepWebLinks`), and a finished output with more page
 * objects than pages is refused (`hasStrayPages`). A file whose page tree has a child that
 * is no page or page tree, or a count that does not match its leaves, is refused as broken
 * (`hasSoundPageTree`): the pages pdf-lib does not see would be lost without a word.
 *
 * This is NOT a way to remove confidential content. Pages that are left out leave the page
 * tree, but data they share with kept pages (fonts, images, other resources) may remain in
 * the file, and the tool does not black out anything; the page says both.
 */

/**
 * The limits are PROVISIONAL until they are measured in the staging rehearsal (plan
 * v1.1 rev3, "PDF output limits"). There is no worker: the work runs on the page's
 * thread and a large job holds its memory until it is done. They are checked in this
 * order: the selected files' total bytes before any is read, the total pages after
 * parsing, the expanded page selection before copying, the saved size before the Blob.
 */
export const PDF_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const PDF_MAX_PAGES = 500;
export const PDF_MAX_RESULT_BYTES = 100 * 1024 * 1024;

export type RangeIssue =
  | { code: "empty" }
  | { code: "syntax" | "zero" | "reversed"; part: string }
  | { code: "beyond"; part: string; pageCount: number }
  | { code: "tooMany"; max: number };

export type RangeResult = { ok: true; pages: number[] } | { ok: false; issue: RangeIssue };

/** One range part: `5` or `2-4` (spaces around the dash are fine). */
const PART = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * The 1-based pages a range text selects, such as `1-3, 5`. The rules:
 *   - parts are separated by commas; spaces around parts and dashes are ignored;
 *   - a part is a page `n` or a range `a-b`, digits only (no signs, no decimals);
 *   - pages count from 1: `0` is refused, and so is a page after the last one;
 *   - a reversed range such as `5-3` is refused, not reinterpreted;
 *   - a page that appears twice is kept once, at its first place: the order of the
 *     result is the order typed (`5, 1-2` gives 5, 1, 2), duplicates are dropped;
 *   - blank text, an empty part (`1,,2`) and anything else is a syntax issue.
 * The last page of every part is checked against `pageCount` before the part is
 * expanded, and the result may not exceed PDF_MAX_PAGES.
 */
export function parsePageRanges(text: string, pageCount: number): RangeResult {
  if (text.trim() === "") return { ok: false, issue: { code: "empty" } };
  const seen = new Set<number>();
  for (const raw of text.split(",")) {
    const part = raw.trim();
    const match = PART.exec(part);
    if (!match) return { ok: false, issue: { code: "syntax", part } };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first === 0 || last === 0) return { ok: false, issue: { code: "zero", part } };
    if (first > last) return { ok: false, issue: { code: "reversed", part } };
    if (last > pageCount) return { ok: false, issue: { code: "beyond", part, pageCount } };
    for (let page = first; page <= last; page += 1) seen.add(page);
    if (seen.size > PDF_MAX_PAGES) {
      return { ok: false, issue: { code: "tooMany", max: PDF_MAX_PAGES } };
    }
  }
  return { ok: true, pages: [...seen] };
}

export type PdfKind = "merge" | "split" | "rotate" | "delete";

/** What a file must offer: a `File` does. */
export interface PdfSource {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PdfJob {
  kind: PdfKind;
  /** In output order. Merge needs two or more, every other kind exactly one. */
  files: readonly PdfSource[];
  /** The page ranges of split, rotate (empty: every page) and delete. */
  ranges: string;
  /** Rotate: the quarter turn, clockwise (90) or counter-clockwise (-90). */
  turn: 90 | -90;
}

/** Why a job was refused. `name` is the file the refusal is about. */
export type PdfIssue =
  | {
      code:
        | "needTwo"
        | "needOne"
        | "inputTooBig"
        | "tooManyPages"
        | "deleteAll"
        | "strayPages"
        | "resultTooBig";
    }
  | { code: "encrypted" | "broken"; name: string }
  | { code: "ranges"; issue: RangeIssue }
  | { code: "failed" };

export type PdfOutcome =
  { ok: true; bytes: Uint8Array<ArrayBuffer>; pages: number } | { ok: false; issue: PdfIssue };

export type PdfProgress =
  { stage: "file"; index: number; total: number; name: string } | { stage: "saving" };

const refuse = (issue: PdfIssue): PdfOutcome => ({ ok: false, issue });

/** Lets the page paint the progress between two heavy steps. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type PdfLib = typeof import("@cantoo/pdf-lib");

/** The base address of a document's relative web links (`/URI /Base` in its catalog), if any. */
function webBase(lib: PdfLib, doc: PdfLib["PDFDocument"]["prototype"]): string | undefined {
  const { PDFDict, PDFHexString, PDFName, PDFString } = lib;
  const base = doc.catalog.lookupMaybe(PDFName.of("URI"), PDFDict)?.lookup(PDFName.of("Base"));
  return base instanceof PDFString || base instanceof PDFHexString ? base.decodeText() : undefined;
}

/** A link address made absolute against `base`; what is already absolute, or cannot be, stays. */
function absoluteUri(uri: string, base: string | undefined): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/**
 * Replaces the annotations of a page that is about to be copied by plain copies of its web
 * links, a Link whose action is a URI, and drops the page's article beads, additional
 * actions and the private hooks PieceInfo, SeparationInfo and PresSteps (they can name other
 * pages or private data). Every other annotation, a comment, a highlight, a stamp, ink, a
 * form widget or a link to a page, is gone: it names other objects, and copying the page
 * would copy them and the pages they sit on. A kept link is rebuilt from its rectangle and
 * its URI string alone, without a frame; a relative address is made absolute against the
 * source's `/URI /Base` first, because the output has none.
 */
function keepWebLinks(
  lib: PdfLib,
  node: PdfLib["PDFPageLeaf"]["prototype"],
  base: string | undefined,
): void {
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString } = lib;
  const links = [];
  const annots = node.Annots();
  for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
    const annot = annots!.lookupMaybe(i, PDFDict);
    const action = annot?.lookupMaybe(PDFName.of("A"), PDFDict);
    const uri = action?.lookup(PDFName.of("URI"));
    const rect = annot?.lookupMaybe(PDFName.of("Rect"), PDFArray);
    const corners = [0, 1, 2, 3].map((at) => rect?.lookupMaybe(at, PDFNumber)?.asNumber());
    if (
      annot?.lookup(PDFName.of("Subtype")) !== PDFName.of("Link") ||
      action?.lookup(PDFName.of("S")) !== PDFName.of("URI") ||
      !(uri instanceof PDFString || uri instanceof PDFHexString) ||
      corners.some((corner) => corner === undefined)
    ) {
      continue;
    }
    const text = uri.decodeText();
    const absolute = absoluteUri(text, base);
    links.push(
      node.context.register(
        node.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: corners,
          Border: [0, 0, 0],
          A: { S: "URI", URI: absolute === text ? uri : PDFString.of(absolute) },
        }),
      ),
    );
  }
  if (links.length > 0) node.set(PDFName.of("Annots"), node.context.obj(links));
  else node.delete(PDFName.of("Annots"));
  for (const key of ["B", "AA", "PieceInfo", "SeparationInfo", "PresSteps"]) {
    node.delete(PDFName.of(key));
  }
}

/**
 * Whether every child in a document's page tree is a /Pages or /Page dictionary and each
 * /Count matches the pages below it. pdf-lib walks the tree and skips a child it does not
 * recognise (a leaf without /Type), so a file that fails this would lose pages unseen.
 */
function hasSoundPageTree(lib: PdfLib, doc: PdfLib["PDFDocument"]["prototype"]): boolean {
  const { PDFPageLeaf, PDFPageTree } = lib;
  const seen = new Set<object>();
  const leavesOf = (tree: PdfLib["PDFPageTree"]["prototype"]): number | null => {
    if (seen.has(tree)) return null;
    seen.add(tree);
    const kids = tree.Kids();
    let leaves = 0;
    for (let i = 0; i < kids.size(); i += 1) {
      const kid = kids.lookup(i);
      if (kid instanceof PDFPageLeaf) leaves += 1;
      else if (kid instanceof PDFPageTree) {
        const below = leavesOf(kid);
        if (below === null) return null;
        leaves += below;
      } else return null;
    }
    return tree.Count().asNumber() === leaves ? leaves : null;
  };
  try {
    return leavesOf(doc.catalog.Pages()) !== null;
  } catch {
    return false;
  }
}

/**
 * Whether a document has page objects beyond the pages of its page tree: a page that came
 * along by a reference (see keepWebLinks) and would be saved with its content, unseen.
 */
function hasStrayPages(lib: PdfLib, doc: PdfLib["PDFDocument"]["prototype"]): boolean {
  const { PDFDict, PDFName } = lib;
  let pageObjects = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.lookup(PDFName.of("Type")) === PDFName.of("Page")) {
      pageObjects += 1;
    }
  }
  return pageObjects !== doc.getPageCount();
}

/** The 0-based pages a job copies (`keep`, in output order) and rotates (`turned`). */
function selectPages(
  job: PdfJob,
  count: number,
): { keep: number[]; turned: Set<number> } | PdfIssue {
  const all = Array.from({ length: count }, (_, i) => i);
  if (job.kind === "merge") return { keep: all, turned: new Set() };
  if (job.kind === "rotate" && job.ranges.trim() === "") return { keep: all, turned: new Set(all) };
  const parsed = parsePageRanges(job.ranges, count);
  if (!parsed.ok) return { code: "ranges", issue: parsed.issue };
  const picked = parsed.pages.map((page) => page - 1);
  if (job.kind === "split") return { keep: picked, turned: new Set() };
  if (job.kind === "rotate") return { keep: all, turned: new Set(picked) };
  const keep = all.filter((i) => !picked.includes(i));
  return keep.length === 0 ? { code: "deleteAll" } : { keep, turned: new Set() };
}

/**
 * Runs one job, one file after another. Encrypted files are refused and never opened
 * (`ignoreEncryption` is never set; pdf-lib throws `EncryptedPDFError` for a file with an
 * /Encrypt entry, a password-protected one and an owner-password-only one alike). Any
 * other file pdf-lib cannot parse is "broken". Refusals come back as values; an
 * unexpected failure is `failed`.
 */
export async function runPdfJob(
  job: PdfJob,
  onProgress: (progress: PdfProgress) => void = () => {},
): Promise<PdfOutcome> {
  const { files } = job;
  if (job.kind === "merge" ? files.length < 2 : files.length !== 1) {
    return refuse({ code: job.kind === "merge" ? "needTwo" : "needOne" });
  }
  // 1. The total bytes, before a single file is read.
  if (files.reduce((sum, file) => sum + file.size, 0) > PDF_MAX_INPUT_BYTES) {
    return refuse({ code: "inputTooBig" });
  }
  try {
    const lib = await import("@cantoo/pdf-lib");
    const { PDFDocument, EncryptedPDFError, ParseSpeeds, degrees } = lib;
    const output = await PDFDocument.create();
    let totalPages = 0;
    for (const [index, file] of files.entries()) {
      onProgress({ stage: "file", index, total: files.length, name: file.name });
      await nextTask();
      let source: Awaited<ReturnType<typeof PDFDocument.load>>;
      let count: number;
      const buffer = await file.arrayBuffer().catch(() => null);
      try {
        if (!buffer) throw new Error("unreadable");
        // throwOnInvalidObject: an object pdf-lib cannot parse makes the file "broken"
        // instead of being copied on as an invalid object.
        source = await PDFDocument.load(buffer, {
          parseSpeed: ParseSpeeds.Fast,
          throwOnInvalidObject: true,
        });
        // A file can load and still have no page tree.
        count = source.getPageCount();
      } catch (error) {
        // The strict parse already trips over the scrambled objects of an encrypted file,
        // before pdf-lib looks at /Encrypt: ask the lenient parse which of the two it is.
        const encrypted =
          error instanceof EncryptedPDFError ||
          (buffer !== null &&
            (await PDFDocument.load(buffer, { parseSpeed: ParseSpeeds.Fast }).then(
              () => false,
              (lenient) => lenient instanceof EncryptedPDFError,
            )));
        return refuse({ code: encrypted ? "encrypted" : "broken", name: file.name });
      }
      if (count === 0 || !hasSoundPageTree(lib, source)) {
        return refuse({ code: "broken", name: file.name });
      }
      // 2. The total pages, after parsing and before anything is copied.
      totalPages += count;
      if (totalPages > PDF_MAX_PAGES) return refuse({ code: "tooManyPages" });

      // 3. The expanded selection, before copying (parsePageRanges caps it too).
      const selection = selectPages(job, count);
      if ("code" in selection) return refuse(selection);
      const { keep, turned } = selection;
      const pages = source.getPages();
      const base = webBase(lib, source);
      for (const at of keep) keepWebLinks(lib, pages[at]!.node, base);
      let copies;
      try {
        copies = await output.copyPages(source, keep);
      } catch {
        return refuse({ code: "broken", name: file.name });
      }
      copies.forEach((page, i) => {
        if (turned.has(keep[i]!)) {
          page.setRotation(degrees((((page.getRotation().angle + job.turn) % 360) + 360) % 360));
        }
        output.addPage(page);
      });
    }
    if (hasStrayPages(lib, output)) return refuse({ code: "strayPages" });
    onProgress({ stage: "saving" });
    await nextTask();
    const bytes = await output.save();
    // 4. The saved size, before it becomes a Blob.
    if (bytes.length > PDF_MAX_RESULT_BYTES) return refuse({ code: "resultTooBig" });
    return { ok: true, bytes, pages: output.getPageCount() };
  } catch {
    return refuse({ code: "failed" });
  }
}
