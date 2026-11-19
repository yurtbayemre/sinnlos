/**
 * The PDF tools of /tools/pdf (v1.1 "Tools"): merge, split by page ranges, rotate and
 * delete pages, entirely in the browser. No file, page range or result leaves the page:
 * this module imports no server action and no API client, and makes no request (pinned by
 * components/tools/browser-tools.test.ts).
 *
 * `@cantoo/pdf-lib` is loaded with a dynamic import() when a job runs or a file is
 * chosen (`warmUpPdfLibrary`), so it is in no route's first-load JS. Every operation
 * builds a NEW document from copied pages (merge, split, rotate and delete alike): a
 * deleted or unselected page is not in the output file at all, which an in-place
 * `removePage` would not guarantee (the page's objects stay in the saved file). What
 * the copy does not carry (forms, bookmarks, tags, signatures, document properties) is
 * said on the page; the tool promises nothing about them and does not redact content.
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
  | { code: "needTwo" | "needOne" | "inputTooBig" | "tooManyPages" | "deleteAll" | "resultTooBig" }
  | { code: "encrypted" | "broken"; name: string }
  | { code: "ranges"; issue: RangeIssue }
  | { code: "failed" };

export type PdfOutcome =
  { ok: true; bytes: Uint8Array<ArrayBuffer>; pages: number } | { ok: false; issue: PdfIssue };

export type PdfProgress =
  { stage: "file"; index: number; total: number; name: string } | { stage: "saving" };

const refuse = (issue: PdfIssue): PdfOutcome => ({ ok: false, issue });

/** Loads the library ahead of the job (a file was chosen), so the first run starts at once. */
export function warmUpPdfLibrary(): void {
  void import("@cantoo/pdf-lib").catch(() => {});
}

/** Lets the page paint the progress between two heavy steps. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    const { PDFDocument, EncryptedPDFError, ParseSpeeds, degrees } =
      await import("@cantoo/pdf-lib");
    const output = await PDFDocument.create();
    let totalPages = 0;
    for (const [index, file] of files.entries()) {
      onProgress({ stage: "file", index, total: files.length, name: file.name });
      await nextTask();
      let source: Awaited<ReturnType<typeof PDFDocument.load>>;
      let count: number;
      try {
        source = await PDFDocument.load(await file.arrayBuffer(), {
          parseSpeed: ParseSpeeds.Fast,
        });
        // A file can load and still have no page tree.
        count = source.getPageCount();
      } catch (error) {
        return refuse({
          code: error instanceof EncryptedPDFError ? "encrypted" : "broken",
          name: file.name,
        });
      }
      if (count === 0) return refuse({ code: "broken", name: file.name });
      // 2. The total pages, after parsing and before anything is copied.
      totalPages += count;
      if (totalPages > PDF_MAX_PAGES) return refuse({ code: "tooManyPages" });

      // 3. The expanded selection, before copying (parsePageRanges caps it too).
      const selection = selectPages(job, count);
      if ("code" in selection) return refuse(selection);
      const { keep, turned } = selection;
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
