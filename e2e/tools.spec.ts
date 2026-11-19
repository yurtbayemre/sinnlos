import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * The browser tools of /tools (v1.1 "Tools"): the PDF tools. Everything happens in the
 * browser, so only a browser run can show it:
 *   - pdf-merge: two PDFs are merged in the order the buttons give, the downloaded file has
 *     the summed page count and the pages in that order; an encrypted file is refused by
 *     name and nothing is downloaded;
 *   - tools-send-nothing: with sentinel data in a PDF, a request listener sees no
 *     request that carries it, including after client-side navigation from another page;
 *   - pdf-ten-jobs-memory-guide: ten jobs in a row, as a ROUGH Chromium guide to
 *     memory (the JS heap only; its thresholds are provisional until the staging rehearsal,
 *     like the limits in lib/pdf-tools.ts).
 * The PDFs are made here at test time with the web app's own @cantoo/pdf-lib (resolved
 * from apps/web, so e2e adds no dependency).
 */
interface PdfDocument {
  addPage(size: [number, number]): unknown;
  getPageCount(): number;
  getPage(index: number): { getWidth(): number };
  context: {
    lookup(ref: unknown): { set(key: unknown, value: unknown): void };
    trailerInfo: { Info: unknown };
  };
  encrypt(options: { userPassword: string; ownerPassword: string }): void;
  save(options?: { useObjectStreams?: boolean }): Promise<Uint8Array>;
}
interface PdfLib {
  PDFDocument: {
    create(): Promise<PdfDocument>;
    load(bytes: Uint8Array): Promise<PdfDocument>;
  };
  PDFName: { of(name: string): unknown };
  PDFString: { of(text: string): unknown };
}
const pdfLib = createRequire(join(__dirname, "..", "apps", "web", "package.json"))(
  "@cantoo/pdf-lib",
) as PdfLib;

/** A PDF of `pages` square pages `size` points wide; `marker` goes in as a plain-text entry of the info dictionary. */
async function makePdf(pages: number, size: number, marker?: string): Promise<Buffer> {
  const { PDFDocument, PDFName, PDFString } = pdfLib;
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([size, size]);
  if (marker) {
    doc.context
      .lookup(doc.context.trailerInfo.Info)
      .set(PDFName.of("Marker"), PDFString.of(marker));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function lockedPdf(): Promise<Buffer> {
  const doc = await pdfLib.PDFDocument.create();
  doc.addPage([100, 100]);
  doc.encrypt({ userPassword: "open-sesame", ownerPassword: "owner-secret" });
  return Buffer.from(await doc.save());
}

const pdfFile = (name: string, buffer: Buffer) => ({ name, mimeType: "application/pdf", buffer });

/** From the home page, by client-side navigation only (no full page load), to the PDF tool. */
async function openPdfTool(page: Page) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Tools", exact: true })
    .click();
  await expect(page).toHaveURL("/tools");
  await page.getByRole("link", { name: /PDF tools/ }).click();
  await expect(page).toHaveURL("/tools/pdf");
  await expect(page.getByRole("heading", { level: 1, name: "PDF tools" })).toBeVisible();
  // Unlocked only once the document is known to carry no analytics (useCleanDocument).
  await expect(page.getByLabel("PDF files", { exact: true })).toBeEnabled();
}

const names = (page: Page) =>
  page.getByRole("list", { name: "Chosen files" }).getByRole("listitem");

test("pdf-merge", async ({ page }, testInfo) => {
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);
  await openPdfTool(page);
  const files = page.getByLabel("PDF files", { exact: true });
  const run = page.getByRole("button", { name: "Create new PDF", exact: true });

  await test.step("Two files are merged in the order the buttons give", async () => {
    // a.pdf: 2 pages 200 pt wide, b.pdf: 3 pages 300 pt wide.
    await files.setInputFiles([
      pdfFile("a.pdf", await makePdf(2, 200)),
      pdfFile("b.pdf", await makePdf(3, 300)),
    ]);
    await expect(names(page)).toContainText(["a.pdf", "b.pdf"]);
    await expect(page.getByRole("button", { name: "Move a.pdf up", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move b.pdf down", exact: true })).toBeDisabled();

    // By keyboard: focus the button, press Enter. The focus stays on it, and the move is announced.
    const moveUp = page.getByRole("button", { name: "Move b.pdf up", exact: true });
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect(names(page)).toContainText(["b.pdf", "a.pdf"]);
    await expect(
      page.getByRole("status").filter({ hasText: "b.pdf is now at position 1 of 2." }),
    ).toBeAttached();
    await expect(page.getByRole("button", { name: "Move b.pdf down", exact: true })).toBeFocused();

    await run.click();
    await expect(page.getByRole("status").filter({ hasText: /^Done: 5 pages/ })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download merged.pdf", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("merged.pdf");
    const saved = testInfo.outputPath("merged.pdf");
    await download.saveAs(saved);
    const merged = await pdfLib.PDFDocument.load(readFileSync(saved));
    expect(merged.getPageCount()).toBe(5);
    // b.pdf's three pages came first.
    expect([0, 1, 2, 3, 4].map((i) => merged.getPage(i).getWidth())).toEqual([
      300, 300, 300, 200, 200,
    ]);
  });

  await test.step("An encrypted file is refused by name, and nothing is offered for download", async () => {
    await files.setInputFiles(pdfFile("locked.pdf", await lockedPdf()));
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(0);
    await run.click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /^locked\.pdf is encrypted or password-protected/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(0);
  });

  await test.step("A range beyond the page count is refused with the count", async () => {
    await page.getByRole("radio", { name: "Pick pages", exact: true }).check();
    // The list still holds the other files: this action takes exactly one.
    await run.click();
    await expect(page.getByRole("alert")).toContainText("exactly one file");
    for (const name of ["a.pdf", "b.pdf"]) {
      await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    }
    await page.getByRole("button", { name: "Remove locked.pdf", exact: true }).click();
    await files.setInputFiles(pdfFile("three.pdf", await makePdf(3, 200)));
    await page.getByLabel("Pages", { exact: true }).fill("2-4");
    await run.click();
    await expect(page.getByRole("alert")).toContainText("The file has only 3 pages.");
    await page.getByLabel("Pages", { exact: true }).fill("3, 1");
    await run.click();
    await expect(page.getByRole("status").filter({ hasText: /^Done: 2 pages/ })).toBeVisible();
  });
});

const SENTINEL = "SINNLOS-E2E-SENTINEL-4f9c1d";

test("tools-send-nothing", async ({ page }) => {
  const fixtures = loadFixtures();
  const requests: Array<{ url: string; headers: string; body: Buffer | null }> = [];
  page.on("request", (request) =>
    requests.push({
      url: request.url(),
      headers: JSON.stringify(request.headers()),
      body: request.postDataBuffer(),
    }),
  );
  const carrying = () =>
    requests.filter(
      (request) =>
        request.url.includes(SENTINEL) ||
        request.headers.includes(SENTINEL) ||
        request.body?.includes(SENTINEL),
    );

  await signIn(page, fixtures.users.member);
  // Arrive from a page of the app, so the tool opens through client-side navigation.
  await page.goto("/people");
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  const marked = await makePdf(2, 200, SENTINEL);
  expect(marked.includes(SENTINEL), "the sentinel is plain text in the file").toBe(true);

  await test.step("A PDF with a sentinel is merged and downloaded; no request carries it", async () => {
    await openPdfTool(page);
    await page
      .getByLabel("PDF files", { exact: true })
      .setInputFiles([pdfFile("marked.pdf", marked), pdfFile("plain.pdf", await makePdf(1, 200))]);
    await page.getByRole("button", { name: "Create new PDF", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^Done: 3 pages/ })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download merged.pdf", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("merged.pdf");
    expect(carrying()).toEqual([]);
  });
});

/**
 * ROUGH GUIDE, not a gate: ten jobs in a row, then the JS heap after a forced collection
 * against the heap after the first job. `performance.memory` is Chromium-only and counts
 * the JS heap, not Blob storage, so it can miss a retained result; the numbers go into the
 * test annotations for the staging rehearsal, where the limits of lib/pdf-tools.ts are
 * measured with real files. The threshold is provisional.
 */
test("pdf-ten-jobs-memory-guide", async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);
  await openPdfTool(page);
  await page
    .getByLabel("PDF files", { exact: true })
    .setInputFiles([
      pdfFile("one.pdf", await makePdf(40, 200)),
      pdfFile("two.pdf", await makePdf(40, 300)),
    ]);
  const run = page.getByRole("button", { name: "Create new PDF", exact: true });
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return page.evaluate(
      () =>
        (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize,
    );
  };

  const used: number[] = [];
  for (let job = 1; job <= 10; job += 1) {
    await run.click();
    // The click has already turned the button busy (the update is flushed with the event).
    await expect(run).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: /^Done: 80 pages/ })).toBeVisible();
    used.push(await heap());
  }
  test.info().annotations.push({
    type: "heap-bytes-after-each-job",
    description: used.join(", "),
  });
  expect(used[9]!, "heap after job 10 against job 1").toBeLessThan(used[0]! * 1.25 + 5_000_000);
});
