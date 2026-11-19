import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * Processes (v1.1 "Tools", BPMN, bpmn-js 18.33.0): an editor imports a diagram in the
 * browser and publishes it; a member reads it in the viewer and downloads it. Also checked here,
 * because only a browser can:
 *   - the bpmn.io watermark (`.bjs-powered-by`, part of the bpmn-js license) is visible
 *     and not covered, in the editor and in the viewer;
 *   - hostile content: a colour that is a url() is refused at import (Chromium would
 *     request it, in the viewer and in an exported .svg opened as a file), and labels
 *     and documentation with markup or handlers run no script and make no request;
 *   - the exported .svg, reopened as a file, makes no network request;
 *   - a file bpmn-js refuses only while drawing it, imported after an edit, leaves the
 *     edited diagram in place;
 *   - the keyboard path: import, description, save, publish and the canvas as a tab stop.
 */
const NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const EVIL = "http://evil.invalid:9";

const diagram = (name: string, attributes = "") => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="${NS}" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start" name="${name}">
      <bpmn:documentation>&lt;script&gt;window.__ran = true&lt;/script&gt;&lt;img src="${EVIL}/doc.png"&gt;</bpmn:documentation>
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Check" name="Check the delivery note" onclick="window.__ran = true">
      <bpmn:incoming>Flow_1</bpmn:incoming>
    </bpmn:task>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start" targetRef="Check" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_di" bpmnElement="Start" ${attributes}><dc:Bounds x="152" y="102" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Check_di" bpmnElement="Check" bioc:stroke="#1a2b3c" bioc:fill="#eef"><dc:Bounds x="240" y="80" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="188" y="120" /><di:waypoint x="240" y="120" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const TITLE = "E2E Goods receipt";
const SUMMARY =
  "Goods arrive, someone checks the delivery note. If it is complete they are put away, otherwise sent back.";

/** The watermark is there, visible and the topmost element at its own centre. */
async function expectWatermark(page: Page) {
  const mark = page.locator(".bjs-powered-by");
  await mark.scrollIntoViewIfNeeded();
  await expect(mark).toBeVisible();
  const covered = await mark.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !element.contains(top);
  });
  expect(covered, "something covers the bpmn.io watermark").toBe(false);
}

test("process-authoring-and-reading", async ({ page, browser }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const requests: string[] = [];
  const dialogs: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const evilRequests = () => requests.filter((url) => url.includes("evil.invalid"));

  await test.step("An editor imports a file: a url() colour is refused, a clean file with hostile text is not", async () => {
    await signIn(page, fixtures.users.editor);
    await page.goto("/manage/processes/new");
    await main.getByRole("textbox", { name: "Title", exact: true }).fill(TITLE);
    await main.getByRole("textbox", { name: "Description", exact: true }).fill(SUMMARY);
    await expectWatermark(page);

    const importInput = main.getByLabel("Import a .bpmn file");
    await importInput.setInputFiles({
      name: "hostile.bpmn",
      mimeType: "application/xml",
      buffer: Buffer.from(diagram("Start", `bioc:stroke="url(${EVIL}/stroke.svg#a)"`)),
    });
    const refusedNote = main.getByText("This file is not a BPMN 2.0 diagram that can be stored.", {
      exact: true,
    });
    await expect(refusedNote).toBeVisible();
    // The empty namespace prefix: bpmn-moddle reads `:fill` under `xmlns:="…biocolor…"` as bioc:fill.
    await importInput.setInputFiles({
      name: "prefix.bpmn",
      mimeType: "application/xml",
      buffer: Buffer.from(
        diagram("Start", `:fill="url(${EVIL}/fill.svg#a)"`).replace(
          "xmlns:bioc=",
          'xmlns:="http://bpmn.io/schema/bpmn/biocolor/1.0" xmlns:bioc=',
        ),
      ),
    });
    await expect(refusedNote).toBeVisible();

    await importInput.setInputFiles({
      name: "order.bpmn",
      mimeType: "application/xml",
      buffer: Buffer.from(diagram("&lt;img src=x onerror=window.__ran=true&gt;")),
    });
    await expect(main.getByText("File imported. Save to keep it.", { exact: true })).toBeVisible();
    await expect(main.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expectWatermark(page);

    // An edit (delete the task), then a file bpmn-js refuses only while drawing it (no
    // BPMNDiagram): the edited diagram stays, the refused one is never what is saved.
    await main.locator('.djs-element[data-element-id="Check"]').click();
    await page.keyboard.press("Delete");
    await expect(main.locator('.djs-element[data-element-id="Check"]')).toHaveCount(0);
    await importInput.setInputFiles({
      name: "no-diagram.bpmn",
      mimeType: "application/xml",
      buffer: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="${NS}" id="Refused_1" targetNamespace="http://bpmn.io/schema/bpmn"><bpmn:process id="Refused_Process"><bpmn:task id="Refused_Task" /></bpmn:process></bpmn:definitions>`,
      ),
    });
    await expect(refusedNote).toBeVisible();
    await expect(main.locator('.djs-element[data-element-id="Start"]')).toHaveCount(1);

    await main.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\/processes\/(?!new$)[^/]+$/);
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved as a draft\.$/ }),
    ).toBeVisible();
    await main.getByRole("button", { name: "Publish", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Publish now?", exact: true })
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(page.getByRole("status").filter({ hasText: /^Published\.$/ })).toBeVisible();
    expect(evilRequests()).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  await test.step("The keyboard path: a process imported, described, saved and published by keyboard only", async () => {
    await page.goto("/manage/processes/new");
    await expect(
      main.getByText(
        "Drawing diagrams needs a mouse or touch; import and the text description work by keyboard.",
      ),
    ).toBeVisible();
    const title = main.getByRole("textbox", { name: "Title", exact: true });
    await title.focus();
    await page.keyboard.type("E2E Keyboard process");
    await page.keyboard.press("Tab");
    await expect(main.getByRole("textbox", { name: "Description", exact: true })).toBeFocused();
    await page.keyboard.type("Typed by keyboard: one start event, nothing else.");

    const importInput = main.getByLabel("Import a .bpmn file");
    await importInput.focus();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.keyboard.press("Space"),
    ]);
    await chooser.setFiles({
      name: "keyboard.bpmn",
      mimeType: "application/xml",
      buffer: Buffer.from(diagram("Keyboard start")),
    });
    await expect(main.getByText("File imported. Save to keep it.", { exact: true })).toBeVisible();
    // The canvas follows the import field in the tab order.
    await importInput.focus();
    await page.keyboard.press("Tab");
    await expect(main.getByRole("group", { name: "Diagram editor", exact: true })).toBeFocused();

    await main.getByRole("button", { name: "Save draft", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/manage\/processes\/(?!new$)[^/]+$/);
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved as a draft\.$/ }),
    ).toBeVisible();
    await main.getByRole("button", { name: "Publish", exact: true }).focus();
    await page.keyboard.press("Enter");
    const confirm = page
      .getByRole("dialog", { name: "Publish now?", exact: true })
      .getByRole("button", { name: "Publish", exact: true });
    await confirm.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: /^Published\.$/ })).toBeVisible();
  });

  await test.step("A member finds it under Tools, reads the description and sees the diagram with the watermark", async () => {
    const reader = await browser.newContext();
    const readerPage = await reader.newPage();
    const readerRequests: string[] = [];
    readerPage.on("request", (request) => readerRequests.push(request.url()));
    readerPage.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await signIn(readerPage, fixtures.users.member);
    await readerPage
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Tools", exact: true })
      .click();
    await expect(readerPage).toHaveURL("/tools");
    await readerPage.getByRole("link", { name: /Processes/ }).click();
    await expect(readerPage).toHaveURL("/tools/processes");
    await readerPage.getByRole("link", { name: new RegExp(TITLE) }).click();
    await expect(readerPage.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await expect(readerPage.getByText(SUMMARY, { exact: true })).toBeVisible();
    await expect(
      readerPage.getByRole("img", { name: `Diagram of the process ${TITLE}` }),
    ).toBeVisible();
    await expectWatermark(readerPage);
    // The labels are text in the picture, never markup.
    await expect(readerPage.locator(".djs-container svg script")).toHaveCount(0);
    expect(await readerPage.evaluate(() => "__ran" in window)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "sinnlos-process-"));
    const [bpmnDownload] = await Promise.all([
      readerPage.waitForEvent("download"),
      readerPage.getByRole("button", { name: "Download .bpmn", exact: true }).click(),
    ]);
    expect(bpmnDownload.suggestedFilename()).toBe("e2e-goods-receipt.bpmn");
    const bpmnFile = join(dir, bpmnDownload.suggestedFilename());
    await bpmnDownload.saveAs(bpmnFile);
    const stored = readFileSync(bpmnFile, "utf8");
    expect(stored).toContain(`xmlns:bpmn="${NS}"`);
    expect(stored).toContain('id="Start"');
    expect(stored).not.toContain('id="Check"');
    expect(stored).not.toContain("Refused");

    const [svgDownload] = await Promise.all([
      readerPage.waitForEvent("download"),
      readerPage.getByRole("button", { name: "Download .svg", exact: true }).click(),
    ]);
    expect(svgDownload.suggestedFilename()).toBe("e2e-goods-receipt.svg");
    const svgFile = join(dir, svgDownload.suggestedFilename());
    await svgDownload.saveAs(svgFile);
    const svg = readFileSync(svgFile, "utf8");
    expect(svg).toMatch(/^<\?xml|^<svg/);
    expect(svg).not.toMatch(/<script|\son\w+=|evil\.invalid|url\(\s*["']?https?:/i);

    // The exported file, reopened as a document of its own: it runs nothing, requests nothing.
    const fileRequests: string[] = [];
    const filePage = await reader.newPage();
    filePage.on("request", (request) => fileRequests.push(request.url()));
    filePage.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await filePage.goto(pathToFileURL(svgFile).href);
    await filePage.waitForTimeout(500);
    expect(fileRequests.filter((url) => !url.startsWith("file:"))).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(readerRequests.filter((url) => url.includes("evil.invalid"))).toEqual([]);
    await reader.close();
  });

  await test.step("A team lead reaches the editor for their own department, a member does not", async () => {
    const lead = await browser.newContext();
    const leadPage = await lead.newPage();
    await signIn(leadPage, fixtures.users.lead);
    await leadPage.goto("/manage/processes");
    await expect(leadPage).toHaveURL("/manage/processes");
    await expect(
      leadPage.getByRole("main").getByRole("link", { name: "New process", exact: true }),
    ).toBeVisible();
    await lead.close();

    const member = await browser.newContext();
    const memberPage = await member.newPage();
    await signIn(memberPage, fixtures.users.member);
    await memberPage.goto("/manage/processes");
    await expect(memberPage).not.toHaveURL("/manage/processes");
    await member.close();
  });
});
