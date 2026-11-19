import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * The browser tools of /tools (v1.1 "Tools"): the PDF tools and the QR code page.
 * Everything happens in the browser, so only a browser run can show it:
 *   - pdf-merge: two PDFs are merged in the order the buttons give, the downloaded file has
 *     the summed page count and the pages in that order; an encrypted file is refused by
 *     name and nothing is downloaded;
 *   - qr-png-and-svg: a code for a link downloads as a PNG (a real PNG, at the chosen size)
 *     and an SVG; a Wi-Fi code's picture is named by its kind, never by the password; a line
 *     break in a field and too much data are refused with a message;
 *   - tools-send-nothing: a tool opened by client-side navigation in a document that already
 *     loaded the analytics script stays locked until the full reload; then, with sentinel
 *     data in a PDF and a Wi-Fi password, a request listener sees no request that carries it;
 *   - pdf-ten-jobs-memory-gate: ten jobs in a row. A gate with a PROVISIONAL threshold: it
 *     reads Chromium's JS heap only (not Blob storage), and its threshold and the limits in
 *     lib/pdf-tools.ts are re-measured in the staging rehearsal.
 * The PDFs and the expected QR images are made here at test time with the web app's own
 * @cantoo/pdf-lib and qrcode (resolved from apps/web, so e2e adds no dependency).
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

interface QrLib {
  toString(
    text: string,
    options: { type: "svg"; errorCorrectionLevel: "M"; width: number },
  ): Promise<string>;
}
const qrLib = createRequire(join(__dirname, "..", "apps", "web", "package.json"))(
  "qrcode",
) as QrLib;

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

/**
 * By client-side navigation only (no full page load): the nav, then the hub's tile. The page
 * is not waited for to unlock (see the test that looks at the lock).
 */
async function navigateToTool(page: Page, tile: RegExp, path: string) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Tools", exact: true })
    .click();
  await expect(page).toHaveURL("/tools");
  await page.getByRole("link", { name: tile }).click();
  await expect(page).toHaveURL(path);
}

const pdfFiles = (page: Page) => page.getByLabel("PDF files", { exact: true });
const qrText = (page: Page) => page.getByLabel("The link or text", { exact: true });

async function openPdfTool(page: Page) {
  await navigateToTool(page, /PDF tools/, "/tools/pdf");
  await expect(page.getByRole("heading", { level: 1, name: "PDF tools" })).toBeVisible();
  // Unlocked only once the document is known to carry no analytics (useCleanDocument).
  await expect(pdfFiles(page)).toBeEnabled();
}

async function openQrTool(page: Page) {
  await navigateToTool(page, /QR code/, "/tools/qr");
  await expect(page.getByRole("heading", { level: 1, name: "QR code" })).toBeVisible();
  await expect(qrText(page)).toBeEnabled();
}

/**
 * The document of a tab that loaded Plausible before `tools` was switched on: its script and
 * global. It also records, in sessionStorage (which a reload keeps), whether the tool's first
 * field `selector` was disabled each time the page changed: a reload may not be held up and
 * looked at (Playwright waits for a navigation in flight), so the locked state is logged
 * from inside the old document.
 */
async function contaminate(page: Page, selector: string) {
  await page.evaluate((fieldSelector) => {
    Object.assign(window, { plausible: () => undefined, contaminatedDocument: true });
    const script = document.createElement("script");
    script.dataset.domain = "analytics.invalid";
    document.head.appendChild(script);
    const seen: boolean[] = [];
    new MutationObserver(() => {
      const field = document.querySelector(fieldSelector);
      if (field) seen.push(field.matches(":disabled"));
      sessionStorage.setItem("lockedWhileContaminated", JSON.stringify(seen));
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  }, selector);
}

const names = (page: Page) =>
  page.getByRole("list", { name: "Chosen files" }).getByRole("listitem");

test("pdf-merge", async ({ page }, testInfo) => {
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);
  await openPdfTool(page);
  const files = pdfFiles(page);
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
        .getByRole("main")
        .getByRole("alert")
        .filter({ hasText: /^locked\.pdf is encrypted or password-protected/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Download / })).toHaveCount(0);
  });

  await test.step("A range beyond the page count is refused with the count", async () => {
    await page.getByRole("radio", { name: "Pick pages", exact: true }).check();
    // The list still holds the other files: this action takes exactly one.
    await run.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("exactly one file");
    for (const name of ["a.pdf", "b.pdf"]) {
      await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    }
    await page.getByRole("button", { name: "Remove locked.pdf", exact: true }).click();
    await files.setInputFiles(pdfFile("three.pdf", await makePdf(3, 200)));
    await page.getByLabel("Pages", { exact: true }).fill("2-4");
    await run.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "The file has only 3 pages.",
    );
    await page.getByLabel("Pages", { exact: true }).fill("3, 1");
    await run.click();
    await expect(page.getByRole("status").filter({ hasText: /^Done: 2 pages/ })).toBeVisible();
  });
});

test("qr-png-and-svg", async ({ page }, testInfo) => {
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);
  await openQrTool(page);
  const create = page.getByRole("button", { name: "Create QR code", exact: true });
  const main = page.getByRole("main");

  await test.step("A change while the code is being made drops the answer for the old input", async () => {
    // The library loads on the first click: answer the script requests late, and change the
    // password in between. Only the code for the new password may ever appear.
    const slow = /\/_next\/static\/.*\.js/;
    await page.route(slow, async (route) => {
      await new Promise((done) => setTimeout(done, 1_500));
      await route.continue();
    });
    await page.getByRole("radio", { name: "Wi-Fi", exact: true }).check();
    await page.getByLabel("Network name (SSID)", { exact: true }).fill("race net");
    await page.getByLabel("Password", { exact: true }).fill("old-password");
    await create.click();
    await page.getByLabel("Password", { exact: true }).fill("new-password");
    await page.waitForTimeout(2_500);
    await expect(main.getByRole("img", { name: /QR code/ })).toHaveCount(0);
    await page.unroute(slow);

    await create.click();
    await expect(main.getByRole("img", { name: "QR code for a Wi-Fi login" })).toBeVisible();
    const [svg] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download as SVG", exact: true }).click(),
    ]);
    const file = testInfo.outputPath("race.svg");
    await svg.saveAs(file);
    expect(readFileSync(file, "utf8")).toBe(
      await qrLib.toString("WIFI:T:WPA;S:race net;P:new-password;;", {
        type: "svg",
        errorCorrectionLevel: "M",
        width: 512,
      }),
    );
    await page.getByRole("radio", { name: "Link or text", exact: true }).check();
  });

  await test.step("A link downloads as a PNG at the chosen size, and as an SVG", async () => {
    await qrText(page).fill("https://example.org/qr?e2e=1");
    await page.getByLabel("Size", { exact: true }).selectOption({ label: "Small (256 pixels)" });
    await create.click();
    await expect(main.getByRole("img", { name: "QR code for a link or text" })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "The QR code was created." }),
    ).toBeAttached();

    const [png] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download as PNG", exact: true }).click(),
    ]);
    expect(png.suggestedFilename()).toBe("qr-code.png");
    const pngFile = testInfo.outputPath("qr-code.png");
    await png.saveAs(pngFile);
    const bytes = readFileSync(pngFile);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16), "PNG width").toBe(256);

    const [svg] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download as SVG", exact: true }).click(),
    ]);
    expect(svg.suggestedFilename()).toBe("qr-code.svg");
    const svgFile = testInfo.outputPath("qr-code.svg");
    await svg.saveAs(svgFile);
    expect(readFileSync(svgFile, "utf8")).toBe(
      await qrLib.toString("https://example.org/qr?e2e=1", {
        type: "svg",
        errorCorrectionLevel: "M",
        width: 256,
      }),
    );
  });

  await test.step("A Wi-Fi code is named by its kind, never by its password", async () => {
    await page.getByRole("radio", { name: "Wi-Fi", exact: true }).check();
    // Changing the kind drops the picture of the other one.
    await expect(main.getByRole("img", { name: /QR code/ })).toHaveCount(0);
    await page.getByLabel("Network name (SSID)", { exact: true }).fill("E2E guest net");
    await page.getByLabel("Password", { exact: true }).fill("e2e-wifi-password");
    await create.click();
    const picture = main.getByRole("img", { name: "QR code for a Wi-Fi login", exact: true });
    await expect(picture).toBeVisible();
    expect(await picture.getAttribute("alt")).not.toMatch(/e2e-wifi-password|E2E guest/);
  });

  await test.step("A line break in a field and too much data are refused with a message", async () => {
    await page.getByLabel("Password", { exact: true }).fill("");
    await create.click();
    await expect(
      page.getByRole("main").getByRole("alert").filter({ hasText: "Enter the password" }),
    ).toBeVisible();

    await page.getByRole("radio", { name: "Contact", exact: true }).check();
    await page.getByLabel("First name", { exact: true }).fill("Max");
    // U+2028 would start a new line in some readers; an input field accepts it.
    await page.getByLabel("Last name", { exact: true }).fill("Muster\u2028END:VCARD");
    await create.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "line break or a control character",
    );
    await expect(main.getByRole("img", { name: /QR code/ })).toHaveCount(0);

    await page.getByRole("radio", { name: "Link or text", exact: true }).check();
    await qrText(page).fill("x".repeat(2400));
    await create.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("too much data");
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

  await test.step("In a document that loaded analytics, a tool stays locked until the full reload", async () => {
    const tools = [
      {
        tile: /PDF tools/,
        path: "/tools/pdf",
        field: pdfFiles(page),
        selector: "input[type=file]",
      },
      { tile: /QR code/, path: "/tools/qr", field: qrText(page), selector: "textarea" },
    ];
    for (const { tile, path, field, selector } of tools) {
      await contaminate(page, selector);
      await navigateToTool(page, tile, path);
      // The reload gives a clean document, and only then are the fields free ...
      await expect(field, path + " after the reload").toBeEnabled();
      expect(
        await page.evaluate(() => "contaminatedDocument" in window || "plausible" in window),
        path + ": a document without the analytics script",
      ).toBe(false);
      // ... while in the old document the field was there and disabled every time it was looked at.
      const seen = await page.evaluate(() => sessionStorage.getItem("lockedWhileContaminated"));
      expect(JSON.parse(seen ?? "[]"), path + " in the contaminated document").toEqual(
        expect.arrayContaining([true]),
      );
      expect(JSON.parse(seen ?? "[]")).not.toContain(false);
      await page.evaluate(() => sessionStorage.removeItem("lockedWhileContaminated"));
    }
  });

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

  await test.step("A Wi-Fi password with a sentinel makes a code; no request carries it either", async () => {
    // From the PDF page to the QR page, again without a page load.
    await openQrTool(page);
    await page.getByRole("radio", { name: "Wi-Fi", exact: true }).check();
    await page.getByLabel("Network name (SSID)", { exact: true }).fill("sentinel net");
    await page.getByLabel("Password", { exact: true }).fill(SENTINEL);
    await page.getByRole("button", { name: "Create QR code", exact: true }).click();
    await expect(page.getByRole("img", { name: "QR code for a Wi-Fi login" })).toBeVisible();
    const [png] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download as PNG", exact: true }).click(),
    ]);
    expect(png.suggestedFilename()).toBe("qr-code.png");
    expect(carrying()).toEqual([]);
  });
});

/**
 * A gate with a PROVISIONAL threshold: ten jobs in a row, then the JS heap after a forced
 * collection against the heap after the first job (25 % and 5 MB of slack). `performance.memory`
 * is Chromium-only and counts the JS heap, not Blob storage, so a retained result can slip
 * past it; the numbers go into the test annotations for the staging rehearsal, where the
 * threshold and the limits of lib/pdf-tools.ts are measured with real files and adjusted.
 */
test("pdf-ten-jobs-memory-gate", async ({ page }) => {
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
