import { describe, expect, it, vi } from "vitest";
import {
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_PAGES,
  PDF_MAX_RESULT_BYTES,
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

  it("keeps the typed order and drops a page that comes twice, at its first place", () => {
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

  it("delete keeps the other pages, and a plain deleted page is not copied", async () => {
    const input = await pdf(4, "a.pdf");
    const result = await runPdfJob(job({ kind: "delete", files: [input], ranges: "2-3" }));
    expect(result.ok && (await inspect(result.bytes)).map((page) => page.width)).toEqual([
      100, 400,
    ]);
    // A page of width 300 is a MediaBox of [0 0 300 200]: not in the saved bytes. This is the
    // plain case; what pages share, and what points at a page, is "what a page carries" below.
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

/**
 * What a page carries along. A page copy follows every reference of the page, so a kept
 * page's link or form widget that points at a deleted page would drag it into the output.
 * Page 3 holds a plain-text marker in an uncompressed content stream, so a leaked copy of it
 * is visible in the saved bytes.
 */
const MARKER = "SECRET-MARKER-PAGE-THREE";
const URL_OF_LINK = "https://example.org/a?b=c";

type Lib = typeof import("@cantoo/pdf-lib");

/** Three pages (100, 200 and 300 points wide); page 3 holds the marker. */
async function threePages(lib: Lib) {
  const { PDFDocument, PDFName } = lib;
  const doc = await PDFDocument.create();
  const [first, second, third] = [100, 200, 300].map((width) => doc.addPage([width, 200]));
  third!.node.set(
    PDFName.of("Contents"),
    doc.context.register(doc.context.stream(`BT (${MARKER}) Tj ET`)),
  );
  const ref = (literal: object) => doc.context.register(doc.context.obj(literal as never));
  return { doc, first: first!, second: second!, third: third!, ref };
}

/** Page 1 carries a link to page 3 (by destination and by GoTo) and a web link. */
async function linkedToPageThree() {
  const lib = await import("@cantoo/pdf-lib");
  const { doc, first, third, ref } = await threePages(lib);
  first.node.set(
    lib.PDFName.of("Annots"),
    doc.context.obj([
      ref({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 50, 50], Dest: [third.ref, "Fit"] }),
      ref({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 60, 50, 100],
        A: { S: "GoTo", D: [third.ref, "Fit"] },
      }),
      ref({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 120, 50, 150],
        Border: [1, 1, 1],
        A: { S: "URI", URI: lib.PDFString.of(URL_OF_LINK) },
      }),
    ]),
  );
  return source(await doc.save(), "linked.pdf");
}

/** Page 1 has a form field with a widget on it, and the same field has a widget on page 3. */
async function fieldWithKidOnPageThree() {
  const lib = await import("@cantoo/pdf-lib");
  const { doc, first, third, ref } = await threePages(lib);
  const { PDFName, PDFString } = lib;
  const field = doc.context.obj({ FT: "Tx", T: PDFString.of("name") });
  const fieldRef = doc.context.register(field);
  const widget = (page: typeof first) =>
    ref({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 50, 20], Parent: fieldRef, P: page.ref });
  const onFirst = widget(first);
  const onThird = widget(third);
  field.set(PDFName.of("Kids"), doc.context.obj([onFirst, onThird]));
  first.node.set(PDFName.of("Annots"), doc.context.obj([onFirst]));
  third.node.set(PDFName.of("Annots"), doc.context.obj([onThird]));
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [fieldRef] }));
  return source(await doc.save(), "form.pdf");
}

/** The page objects (/Type /Page) of a saved file, whether or not the page tree reaches them. */
async function pageObjects(bytes: Uint8Array) {
  const { PDFDocument, PDFDict, PDFName } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.lookup(PDFName.of("Type")) === PDFName.of("Page")) {
      count += 1;
    }
  }
  return { count, pages: doc.getPageCount(), text: new TextDecoder("latin1").decode(bytes) };
}

/** What a plain pdf-lib copy of pages 1 and 2 does with the file: the leak the job must stop. */
async function plainCopy(file: PdfSource) {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const from = await PDFDocument.load(await file.arrayBuffer());
  const to = await PDFDocument.create();
  for (const page of await to.copyPages(from, [0, 1])) to.addPage(page);
  return pageObjects(await to.save());
}

describe("runPdfJob: what a page carries along", () => {
  it("the fixtures leak through a plain copy (so the tests below can fail)", async () => {
    for (const file of [await linkedToPageThree(), await fieldWithKidOnPageThree()]) {
      const leaked = await plainCopy(file);
      expect(leaked.pages).toBe(2);
      expect(leaked.count, file.name).toBeGreaterThan(2);
      expect(leaked.text, file.name).toContain(MARKER);
    }
  });

  it.each([
    ["delete page 3", { kind: "delete", ranges: "3" }, 2],
    ["pick pages 1-2", { kind: "split", ranges: "1-2" }, 2],
  ] as const)(
    "%s: a link to the left-out page brings neither it nor its content, and a web link stays",
    async (_name, over, pageCount) => {
      const result = await runPdfJob(job({ ...over, files: [await linkedToPageThree()] }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const out = await pageObjects(result.bytes);
      expect(out).toMatchObject({ count: pageCount, pages: pageCount });
      expect(out.text).not.toContain(MARKER);
      expect(await annotationsOfFirstPage(result.bytes)).toEqual([
        { subtype: "Link", rect: [0, 120, 50, 150], uri: URL_OF_LINK },
      ]);
    },
  );

  it("rotate and merge keep all pages, drop the links between pages and keep the web link", async () => {
    const file = await linkedToPageThree();
    for (const [kind, files, count] of [
      ["rotate", [file], 3],
      ["merge", [file, file], 6],
    ] as const) {
      const result = await runPdfJob(job({ kind, files }));
      expect(result.ok, kind).toBe(true);
      if (!result.ok) continue;
      expect(await pageObjects(result.bytes), kind).toMatchObject({ count, pages: count });
      expect(await annotationsOfFirstPage(result.bytes), kind).toEqual([
        { subtype: "Link", rect: [0, 120, 50, 150], uri: URL_OF_LINK },
      ]);
    }
  });

  it("a form field with a widget on a deleted page brings neither the page nor its content", async () => {
    const result = await runPdfJob(
      job({ kind: "delete", files: [await fieldWithKidOnPageThree()], ranges: "3" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = await pageObjects(result.bytes);
    expect(out).toMatchObject({ count: 2, pages: 2 });
    expect(out.text).not.toContain(MARKER);
    expect(await annotationsOfFirstPage(result.bytes)).toEqual([]);
  });

  it("refuses a result that holds more page objects than pages, whatever reference brought it", async () => {
    // A resource entry (no annotation) that names page 3: not something keepWebLinks sees.
    const lib = await import("@cantoo/pdf-lib");
    const { doc, first, third } = await threePages(lib);
    first.node.set(
      lib.PDFName.of("Resources"),
      doc.context.obj({ Properties: { Extra: third.ref } }),
    );
    const file = source(await doc.save(), "stray.pdf");
    expect((await plainCopy(file)).count).toBeGreaterThan(2);
    expect(await runPdfJob(job({ kind: "delete", files: [file], ranges: "3" }))).toEqual({
      ok: false,
      issue: { code: "strayPages" },
    });
  });

  it("removes every annotation except a web link: a FreeText, a highlight, a note and a popup go", async () => {
    const lib = await import("@cantoo/pdf-lib");
    const { doc, first, ref } = await threePages(lib);
    const note = ref({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 20, 20], Contents: "note" });
    first.node.set(
      lib.PDFName.of("Annots"),
      doc.context.obj([
        ref({
          Type: "Annot",
          Subtype: "FreeText",
          Rect: [10, 10, 90, 40],
          Contents: lib.PDFString.of("DO NOT APPROVE"),
          DA: lib.PDFString.of("/Helv 12 Tf 0 g"),
        }),
        ref({ Type: "Annot", Subtype: "Highlight", Rect: [0, 50, 90, 60], QuadPoints: [] }),
        note,
        ref({ Type: "Annot", Subtype: "Popup", Rect: [0, 0, 50, 50], Parent: note }),
        ref({
          Type: "Annot",
          Subtype: "Link",
          Rect: [0, 120, 50, 150],
          A: { S: "URI", URI: lib.PDFString.of(URL_OF_LINK) },
        }),
      ]),
    );
    const file = source(await doc.save(), "annotated.pdf");
    // A plain copy keeps all five annotations (so the test can see what is removed).
    const plain = await lib.PDFDocument.load(await file.arrayBuffer());
    expect(plain.getPage(0).node.Annots()?.size()).toBe(5);
    const result = await runPdfJob(job({ kind: "rotate", files: [file] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await annotationsOfFirstPage(result.bytes)).toEqual([
      { subtype: "Link", rect: [0, 120, 50, 150], uri: URL_OF_LINK },
    ]);
  });

  it("drops a page's PieceInfo, SeparationInfo and PresSteps, which can name other pages and data", async () => {
    const lib = await import("@cantoo/pdf-lib");
    const { doc, first, second, third } = await threePages(lib);
    const { PDFName, PDFString } = lib;
    // A private entry that names page 3's content, and a list of pages.
    first.node.set(
      PDFName.of("PieceInfo"),
      doc.context.obj({
        App: {
          LastModified: PDFString.of("D:20260101000000Z"),
          Private: third.node.get(PDFName.of("Contents")),
        },
      }),
    );
    first.node.set(
      PDFName.of("SeparationInfo"),
      doc.context.obj({ Pages: [first.ref, second.ref, third.ref], DeviceColorant: "Black" }),
    );
    first.node.set(PDFName.of("PresSteps"), doc.context.obj({ Type: "NavNode", Next: third.ref }));
    const file = source(await doc.save(), "hooks.pdf");
    const plain = await plainCopy(file);
    expect(plain.text, "a plain copy carries page 3's content along").toContain(MARKER);
    expect(plain.count).toBeGreaterThan(2);

    const deleted = await runPdfJob(job({ kind: "delete", files: [file], ranges: "3" }));
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(await pageObjects(deleted.bytes)).toMatchObject({ count: 2, pages: 2 });
    expect((await pageObjects(deleted.bytes)).text).not.toContain(MARKER);
    // Rotating every page was refused by the stray-page guard because of SeparationInfo.
    const rotated = await runPdfJob(job({ kind: "rotate", files: [file] }));
    expect(rotated.ok).toBe(true);
  });

  it("a file without links, forms or references passes the stray-page check", async () => {
    const result = await runPdfJob(
      job({ kind: "split", files: [await pdf(3, "a.pdf")], ranges: "2" }),
    );
    expect(result.ok).toBe(true);
  });
});

/** The annotations of the first page of a saved file: subtype, rectangle and URI. */
async function annotationsOfFirstPage(bytes: Uint8Array) {
  const { PDFDocument, PDFDict, PDFName, PDFString, PDFNumber, PDFArray } =
    await import("@cantoo/pdf-lib");
  const annots = (await PDFDocument.load(bytes)).getPage(0).node.Annots();
  return Array.from({ length: annots?.size() ?? 0 }, (_, i) => {
    const annot = annots!.lookup(i, PDFDict);
    const rect = annot.lookup(PDFName.of("Rect"), PDFArray);
    const uri = annot.lookupMaybe(PDFName.of("A"), PDFDict)?.lookup(PDFName.of("URI"), PDFString);
    return {
      subtype: annot.lookup(PDFName.of("Subtype"), PDFName).decodeText(),
      rect: Array.from({ length: rect.size() }, (_, at) => rect.lookup(at, PDFNumber).asNumber()),
      uri: uri?.decodeText(),
    };
  });
}

describe("runPdfJob: damaged and oversized files", () => {
  it("refuses a file with an object pdf-lib cannot parse, which a lenient load would copy on", async () => {
    const { PDFDocument, PDFName } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const contents = doc.context.register(doc.context.stream("0 0 m 10 10 l S"));
    page.node.set(PDFName.of("Contents"), contents);
    const text = new TextDecoder("latin1").decode(await doc.save({ useObjectStreams: false }));
    const damaged = Uint8Array.from(
      text.replace(`${contents.objectNumber} 0 obj\n<<`, `${contents.objectNumber} 0 obj\n<<<`),
      (char) => char.charCodeAt(0),
    );
    // The lenient load takes the file as it is (this is what the option is for).
    await expect(PDFDocument.load(damaged)).resolves.toBeDefined();
    expect(
      await runPdfJob(job({ kind: "rotate", files: [source(damaged, "damaged.pdf")] })),
    ).toEqual({
      ok: false,
      issue: { code: "broken", name: "damaged.pdf" },
    });
  });

  it("refuses a saved result over the limit, and hands out no bytes and builds no Blob", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const input = await pdf(1, "a.pdf");
    const saved = (length: number) =>
      vi.spyOn(PDFDocument.prototype, "save").mockResolvedValue({ length } as never);
    const blob = vi.spyOn(globalThis, "Blob");
    try {
      saved(PDF_MAX_RESULT_BYTES + 1);
      const refused = await runPdfJob(job({ kind: "rotate", files: [input] }));
      expect(refused).toEqual({ ok: false, issue: { code: "resultTooBig" } });
      expect(refused).not.toHaveProperty("bytes");
      expect(blob).not.toHaveBeenCalled();

      vi.mocked(PDFDocument.prototype.save).mockResolvedValue({
        length: PDF_MAX_RESULT_BYTES,
      } as never);
      expect(await runPdfJob(job({ kind: "rotate", files: [input] }))).toMatchObject({ ok: true });
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("runPdfJob: relative web links", () => {
  /** Page 1 carries four web links; the catalog has a /URI /Base when `base` is given. */
  async function linksFile(base?: string) {
    const lib = await import("@cantoo/pdf-lib");
    const { doc, first, ref } = await threePages(lib);
    const link = (y: number, address: string) =>
      ref({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, y, 50, y + 10],
        A: { S: "URI", URI: lib.PDFString.of(address) },
      });
    first.node.set(
      lib.PDFName.of("Annots"),
      doc.context.obj([
        link(0, "other.html"),
        link(20, "#section"),
        link(40, "https://abs.example/x"),
        link(60, "mailto:a@b.example"),
      ]),
    );
    if (base !== undefined) {
      doc.catalog.set(lib.PDFName.of("URI"), doc.context.obj({ Base: lib.PDFString.of(base) }));
    }
    return source(await doc.save(), "links.pdf");
  }
  const addresses = async (bytes: Uint8Array) =>
    (await annotationsOfFirstPage(bytes)).map((annot) => annot.uri);

  it("resolves a relative address against the source's /URI /Base, and leaves absolute ones alone", async () => {
    const result = await runPdfJob(
      job({ kind: "rotate", files: [await linksFile("http://example.org/docs/")] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await addresses(result.bytes)).toEqual([
      "http://example.org/docs/other.html",
      "http://example.org/docs/#section",
      "https://abs.example/x",
      "mailto:a@b.example",
    ]);
  });

  it("without a base keeps the address as it is, and so does a base that is no address", async () => {
    for (const base of [undefined, "not a base"]) {
      const result = await runPdfJob(job({ kind: "rotate", files: [await linksFile(base)] }));
      expect(result.ok, String(base)).toBe(true);
      if (!result.ok) continue;
      expect(await addresses(result.bytes), String(base)).toEqual([
        "other.html",
        "#section",
        "https://abs.example/x",
        "mailto:a@b.example",
      ]);
    }
  });

  it("uses each file's own base when files are merged", async () => {
    const result = await runPdfJob(
      job({
        kind: "merge",
        files: [await linksFile("http://one.example/a/"), await linksFile("http://two.example/b/")],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { PDFDocument, PDFDict, PDFName, PDFString } = await import("@cantoo/pdf-lib");
    const merged = await PDFDocument.load(result.bytes);
    const first = (page: number) => {
      const annots = merged.getPage(page).node.Annots()!;
      return annots
        .lookup(0, PDFDict)
        .lookup(PDFName.of("A"), PDFDict)
        .lookup(PDFName.of("URI"), PDFString)
        .decodeText();
    };
    expect([first(0), first(3)]).toEqual([
      "http://one.example/a/other.html",
      "http://two.example/b/other.html",
    ]);
  });
});

describe("runPdfJob: a page tree pdf-lib reads only in part", () => {
  const damagedTree = async (
    change: (lib: Lib, doc: Awaited<ReturnType<typeof threePages>>) => void,
  ) => {
    const lib = await import("@cantoo/pdf-lib");
    const parts = await threePages(lib);
    change(lib, parts);
    return source(await parts.doc.save(), "tree.pdf");
  };

  it("refuses a file with a page that has no /Type (pdf-lib would see one page less)", async () => {
    const file = await damagedTree((lib, { second }) => second.node.delete(lib.PDFName.of("Type")));
    // The fixture is real: a lenient load counts two pages, not three, with /Count 3.
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    expect((await PDFDocument.load(await file.arrayBuffer())).getPageCount()).toBe(2);
    for (const kind of ["rotate", "merge"] as const) {
      const files = kind === "merge" ? [file, file] : [file];
      expect(await runPdfJob(job({ kind, files })), kind).toEqual({
        ok: false,
        issue: { code: "broken", name: "tree.pdf" },
      });
    }
  });

  it("refuses a /Count that does not match the pages below it, either way", async () => {
    for (const count of [2, 4]) {
      const file = await damagedTree((lib, { doc }) =>
        doc.catalog.Pages().set(lib.PDFName.of("Count"), lib.PDFNumber.of(count)),
      );
      expect(await runPdfJob(job({ kind: "rotate", files: [file] })), String(count)).toEqual({
        ok: false,
        issue: { code: "broken", name: "tree.pdf" },
      });
    }
  });

  it("refuses a page tree that contains itself", async () => {
    const file = await damagedTree((lib, { doc }) => {
      const tree = doc.catalog.Pages();
      tree.Kids().push(doc.catalog.get(lib.PDFName.of("Pages"))!);
      tree.set(lib.PDFName.of("Count"), lib.PDFNumber.of(3));
    });
    expect(await runPdfJob(job({ kind: "rotate", files: [file] }))).toEqual({
      ok: false,
      issue: { code: "broken", name: "tree.pdf" },
    });
  });

  it("takes an ordinary file", async () => {
    const file = await damagedTree(() => {});
    expect(await runPdfJob(job({ kind: "rotate", files: [file] }))).toMatchObject({ ok: true });
  });
});
