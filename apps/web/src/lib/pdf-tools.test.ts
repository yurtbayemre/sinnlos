import { describe, expect, it, vi } from "vitest";
import {
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_PAGES,
  parsePageRanges,
  runPdfJob,
  type PdfJob,
  type PdfSource,
} from "./pdf-tools";

/**
 * The PDF tools: the range parser (the rules are in its doc comment) and the job runner
 * against real documents made with pdf-lib at test time. The browser side (the page, the
 * download) is e2e/tools.spec.ts.
 */
const pages = (text: string, count: number) => {
  const result = parsePageRanges(text, count);
  return result.ok ? result.pages : result.issue;
};

describe("parsePageRanges", () => {
  it("reads pages and ranges, with or without spaces", () => {
    expect(pages("1-3, 5", 9)).toEqual([1, 2, 3, 5]);
    expect(pages("1-3,5", 9)).toEqual([1, 2, 3, 5]);
    expect(pages("  2 ,  4 - 6 ", 9)).toEqual([2, 4, 5, 6]);
    expect(pages("7", 7)).toEqual([7]);
    expect(pages("3-3", 9)).toEqual([3]);
  });

  it("keeps the typed order and drops a page that comes twice, at its later place", () => {
    expect(pages("5, 1-2", 9)).toEqual([5, 1, 2]);
    expect(pages("1-3, 2, 3-4", 9)).toEqual([1, 2, 3, 4]);
    expect(pages("4,4,4", 9)).toEqual([4]);
  });

  it("refuses blank text", () => {
    expect(pages("", 3)).toEqual({ code: "empty" });
    expect(pages("  \t ", 3)).toEqual({ code: "empty" });
  });

  it("refuses page 0, in a page or a range", () => {
    expect(pages("0", 3)).toEqual({ code: "zero", part: "0" });
    expect(pages("1, 0-2", 3)).toEqual({ code: "zero", part: "0-2" });
    expect(pages("00", 3)).toEqual({ code: "zero", part: "00" });
  });

  it("refuses a reversed range instead of reading it the other way", () => {
    expect(pages("5-3", 9)).toEqual({ code: "reversed", part: "5-3" });
  });

  it("refuses a page after the last one, naming the part and the count", () => {
    expect(pages("4", 3)).toEqual({ code: "beyond", part: "4", pageCount: 3 });
    expect(pages("2-4", 3)).toEqual({ code: "beyond", part: "2-4", pageCount: 3 });
    expect(pages("99999999999999999999999", 3)).toMatchObject({ code: "beyond" });
  });

  it.each(["a", "1-", "-3", "1--3", "1-2-3", "1,,2", "1,", ",1", "+2", "1.5", "1 2", "1;2", "١"])(
    "refuses the syntax %j",
    (text) => {
      expect(pages(text, 9)).toMatchObject({ code: "syntax" });
    },
  );

  it("caps the expanded selection and never expands past the page count first", () => {
    expect(pages(`1-${PDF_MAX_PAGES + 1}`, PDF_MAX_PAGES + 1)).toEqual({
      code: "tooMany",
      max: PDF_MAX_PAGES,
    });
    expect(pages("1-1000000000", 3)).toMatchObject({ code: "beyond" });
    expect(pages(`1-${PDF_MAX_PAGES}`, PDF_MAX_PAGES)).toHaveLength(PDF_MAX_PAGES);
  });
});

/** A document of `count` pages, page n being (n * 100) points wide, as the bytes of a file. */
async function pdf(count: number, name: string): Promise<PdfSource> {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.create();
  for (let n = 1; n <= count; n += 1) doc.addPage([n * 100, 200]);
  const bytes = await doc.save();
  return source(bytes, name);
}

function source(bytes: Uint8Array, name: string): PdfSource {
  const copy = bytes.slice().buffer as ArrayBuffer;
  return { name, size: bytes.length, arrayBuffer: async () => copy };
}

/** The widths (n * 100) and rotations of the pages of an output. */
async function inspect(bytes: Uint8Array) {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => ({
    width: page.getWidth(),
    angle: page.getRotation().angle,
  }));
}

const job = (over: Partial<PdfJob> & Pick<PdfJob, "kind" | "files">): PdfJob => ({
  ranges: "",
  turn: 90,
  ...over,
});

describe("runPdfJob: merge", () => {
  it("joins the files in the given order and sums their pages", async () => {
    const a = await pdf(2, "a.pdf");
    const b = await pdf(3, "b.pdf");
    const result = await runPdfJob(job({ kind: "merge", files: [b, a] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toBe(5);
    expect((await inspect(result.bytes)).map((page) => page.width)).toEqual([
      100, 200, 300, 100, 200,
    ]);
  });

  it("reports each file it reads and then the save", async () => {
    const seen: string[] = [];
    await runPdfJob(
      job({ kind: "merge", files: [await pdf(1, "a.pdf"), await pdf(1, "b.pdf")] }),
      (progress) =>
        seen.push(progress.stage === "file" ? `${progress.index}:${progress.name}` : "save"),
    );
    expect(seen).toEqual(["0:a.pdf", "1:b.pdf", "save"]);
  });

  it("needs two files, every other kind exactly one", async () => {
    const a = await pdf(1, "a.pdf");
    expect(await runPdfJob(job({ kind: "merge", files: [a] }))).toEqual({
      ok: false,
      issue: { code: "needTwo" },
    });
    expect(await runPdfJob(job({ kind: "split", files: [a, a], ranges: "1" }))).toEqual({
      ok: false,
      issue: { code: "needOne" },
    });
    expect(await runPdfJob(job({ kind: "rotate", files: [] }))).toEqual({
      ok: false,
      issue: { code: "needOne" },
    });
  });
});

describe("runPdfJob: split, rotate and delete", () => {
  it("split copies the selected pages, in the typed order, into one file", async () => {
    const result = await runPdfJob(
      job({ kind: "split", files: [await pdf(5, "a.pdf")], ranges: "4, 1-2" }),
    );
    expect(result.ok && (await inspect(result.bytes)).map((page) => page.width)).toEqual([
      400, 100, 200,
    ]);
  });

  it("delete keeps the other pages, and the deleted page's objects are not in the file", async () => {
    const input = await pdf(4, "a.pdf");
    const result = await runPdfJob(job({ kind: "delete", files: [input], ranges: "2-3" }));
    expect(result.ok && (await inspect(result.bytes)).map((page) => page.width)).toEqual([
      100, 400,
    ]);
    // A page of width 300 is a MediaBox of [0 0 300 200]: gone from the saved bytes.
    if (result.ok) {
      const text = new TextDecoder("latin1").decode(result.bytes);
      expect(text).not.toMatch(/0 0 300 200/);
      expect(text).toMatch(/0 0 400 200/);
    }
  });

  it("rotate turns the chosen pages by a quarter turn, on top of an existing rotation", async () => {
    const { PDFDocument, degrees } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create();
    for (let n = 1; n <= 3; n += 1) doc.addPage([n * 100, 200]);
    doc.getPage(1).setRotation(degrees(90));
    const file = source(await doc.save(), "r.pdf");
    const turned = await runPdfJob(job({ kind: "rotate", files: [file], ranges: "2-3" }));
    expect(turned.ok && (await inspect(turned.bytes)).map((page) => page.angle)).toEqual([
      0, 180, 90,
    ]);
    const back = await runPdfJob(job({ kind: "rotate", files: [file], ranges: "1", turn: -90 }));
    expect(back.ok && (await inspect(back.bytes)).map((page) => page.angle)).toEqual([270, 90, 0]);
  });

  it("rotate without ranges turns every page", async () => {
    const result = await runPdfJob(job({ kind: "rotate", files: [await pdf(3, "a.pdf")] }));
    expect(result.ok && (await inspect(result.bytes)).map((page) => page.angle)).toEqual([
      90, 90, 90,
    ]);
  });

  it("refuses deleting every page, and range issues, with the issue named", async () => {
    const input = await pdf(2, "a.pdf");
    expect(await runPdfJob(job({ kind: "delete", files: [input], ranges: "1-2" }))).toEqual({
      ok: false,
      issue: { code: "deleteAll" },
    });
    expect(await runPdfJob(job({ kind: "split", files: [input], ranges: "3" }))).toEqual({
      ok: false,
      issue: { code: "ranges", issue: { code: "beyond", part: "3", pageCount: 2 } },
    });
    expect(await runPdfJob(job({ kind: "delete", files: [input], ranges: "" }))).toEqual({
      ok: false,
      issue: { code: "ranges", issue: { code: "empty" } },
    });
  });
});

describe("runPdfJob: refusals", () => {
  it("refuses an encrypted file, by name, and never opens it", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.encrypt({ userPassword: "open", ownerPassword: "owner" });
    const locked = source(await doc.save(), "locked.pdf");
    const result = await runPdfJob(job({ kind: "merge", files: [await pdf(1, "ok.pdf"), locked] }));
    expect(result).toEqual({ ok: false, issue: { code: "encrypted", name: "locked.pdf" } });
  });

  it("refuses an owner-password-only file too (it is still encrypted)", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false } });
    const result = await runPdfJob(
      job({ kind: "rotate", files: [source(await doc.save(), "restricted.pdf")] }),
    );
    expect(result).toEqual({ ok: false, issue: { code: "encrypted", name: "restricted.pdf" } });
  });

  it("names the broken file, whatever its kind of damage", async () => {
    const good = await pdf(1, "good.pdf");
    for (const bytes of [
      new TextEncoder().encode("this is not a pdf"),
      new Uint8Array(0),
      new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog"),
    ]) {
      const result = await runPdfJob(
        job({ kind: "merge", files: [good, source(bytes, "broken.pdf")] }),
      );
      expect(result, String(bytes.length)).toEqual({
        ok: false,
        issue: { code: "broken", name: "broken.pdf" },
      });
    }
  });

  it("refuses by total size before it reads any file", async () => {
    const read = vi.fn(async () => new ArrayBuffer(0));
    const big = { name: "big.pdf", size: PDF_MAX_INPUT_BYTES, arrayBuffer: read };
    const one = { name: "one.pdf", size: 1, arrayBuffer: read };
    expect(await runPdfJob(job({ kind: "merge", files: [big, one] }))).toEqual({
      ok: false,
      issue: { code: "inputTooBig" },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses by total pages once they are parsed, before anything is saved", async () => {
    const a = await pdf(PDF_MAX_PAGES, "a.pdf");
    const b = await pdf(1, "b.pdf");
    expect(await runPdfJob(job({ kind: "merge", files: [a, b] }))).toEqual({
      ok: false,
      issue: { code: "tooManyPages" },
    });
  }, 30_000);
});
