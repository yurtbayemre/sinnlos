import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * Mermaid in Markdown (v1.1 "Tools"): a ```mermaid fence of a Markdown body is drawn as a
 * diagram wherever the renderer is used (here the editor's preview and the announcements
 * page), and it is part of Markdown, not of the `tools` module. Only a browser can show:
 *   - the Mermaid library is not part of any page without a fence: no JS file of `/` or
 *     of the editor (which bundles the renderer for its preview) holds it, the preview of
 *     a fence loads it;
 *   - a fence draws an SVG in the preview and on the server-rendered page, and the page
 *     logs no hydration error;
 *   - a hostile diagram (an `%%{init}%%` that asks for securityLevel "loose", HTML labels
 *     with script and onerror, a click callback, a `javascript:` link) runs nothing, keeps
 *     no handler attribute and no script, and the downgrade does not take effect;
 *   - a diagram that does not parse stays its source with a hint; a plain fence is as before;
 *   - the drawn diagram has an accessible name and the source one disclosure away;
 *   - the theme switch draws it again;
 *   - without JavaScript the page has the source: the HTML the server sends holds each fence
 *     as the plain `<pre><code class="language-mermaid">`, never an SVG.
 */
const TITLE = "E2E Mermaid announcement";
const FLOW = [
  "```mermaid",
  "flowchart TD",
  "  accTitle: Delivery flow",
  "  A[Goods arrive] --> B{Complete?}",
  "  B -->|yes| C[Put away]",
  "  B -->|no| D[Send back]",
  "```",
].join("\n");
const HOSTILE = [
  "```mermaid",
  '%%{init: {"securityLevel": "loose"}}%%',
  "flowchart TD",
  `  A["<img src=x onerror='window.__pwned = 1'><script>window.__pwned = 2</script>"] --> B[Click me]`,
  "  click B call window.__pwned()",
  '  click A href "javascript:window.__pwned = 3"',
  "```",
].join("\n");
const BROKEN = ["```mermaid", "flowchart TD", "  A --> --> B ((((", "```"].join("\n");
const PLAIN = ["```js", "const a = 1;", "```"].join("\n");
const BODY = ["Intro text.", PLAIN, FLOW, HOSTILE, BROKEN].join("\n\n");

const ERROR_HINT = "This diagram could not be drawn. Its source is shown instead.";
/** A string only the Mermaid library holds (its answer to a text over maxTextSize). */
const MERMAID_MARK = "Maximum text size in diagram exceeded";
/** A hydration mismatch, in React's own words (development) and as the production build says it. */
const HYDRATION = /hydrat|Minified React error #(418|419|422|423|425)\b/i;

/** Whether any script this page has loaded so far holds the Mermaid library. */
function watchScripts(page: Page) {
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/_next/static/") && response.url().endsWith(".js")) {
      bodies.push(response.text().catch(() => ""));
    }
  });
  return async () => (await Promise.all(bodies)).some((body) => body.includes(MERMAID_MARK));
}

/** The markup of the first SVG of `groups`: changes when the diagram is drawn again. */
const firstSvg = (groups: Locator) => groups.first().locator("svg").first();

/** Nothing of a hostile diagram is left in `groups`, and nothing ran. */
async function expectInert(page: Page, group: Locator, dialogs: string[]) {
  await expect(group.locator("script, [onerror], [onclick], [onload], [onmouseover]")).toHaveCount(
    0,
  );
  await expect(group.locator('a[href^="javascript:" i], a[href^="data:" i]')).toHaveCount(0);
  await group.getByText("Click me", { exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
    undefined,
  );
  expect(dialogs).toEqual([]);
}

test("mermaid-in-markdown", async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const problems: string[] = [];
  const dialogs: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && HYDRATION.test(message.text())) problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const mermaidLoaded = watchScripts(page);
  const diagrams = () => main.getByRole("group", { name: "Diagram", exact: true });

  await test.step("No page without a fence loads the library, not even the editor that can preview one", async () => {
    await signIn(page, fixtures.users.editor);
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.goto("/manage/announcements/new");
    await expect(main.getByRole("textbox", { name: "Text", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await mermaidLoaded(), "a page without a fence loaded Mermaid").toBe(false);
  });

  await test.step("The preview draws the fences; the downgrade and the hostile labels run nothing", async () => {
    await main.getByRole("textbox", { name: "Title", exact: true }).fill(TITLE);
    await main.getByRole("textbox", { name: "Text", exact: true }).fill(BODY);
    await main.getByRole("tab", { name: "Preview", exact: true }).click();
    const preview = main.getByRole("tabpanel", { name: "Preview" });
    // The fences are the plain source first, then the diagrams.
    await expect(diagrams()).toHaveCount(2);
    await expect(firstSvg(diagrams())).toBeVisible();
    expect(await mermaidLoaded(), "a fence did not load Mermaid").toBe(true);

    await expect(main.getByText(ERROR_HINT, { exact: true })).toBeVisible();
    await expect(
      preview.locator("pre code.language-mermaid", { hasText: "A --> --> B ((((" }),
    ).toBeVisible();
    await expect(preview.locator("pre code.language-js")).toHaveText("const a = 1;\n");
    await expectInert(page, diagrams().nth(1), dialogs);
    expect(problems).toEqual([]);
  });

  await test.step("The editor publishes it", async () => {
    await main.getByRole("button", { name: "Publish", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Publish now?", exact: true })
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /^(Created and published|Published)\.$/ }),
    ).toBeVisible();
  });

  await test.step("The page draws it after a clean hydration, names it and keeps the source one click away", async () => {
    await page.goto("/announcements");
    await expect(main.getByText(TITLE, { exact: true })).toBeVisible();
    await expect(diagrams()).toHaveCount(2);
    await expect(main.getByText(ERROR_HINT, { exact: true })).toBeVisible();
    // The diagram's own title names the SVG, the group names the others.
    await expect(diagrams().first().locator("svg title")).toHaveText("Delivery flow");
    await expect(diagrams().first().locator("svg")).toHaveAttribute("aria-labelledby", /.+/);
    await expectInert(page, diagrams().nth(1), dialogs);

    const source = diagrams().first().locator("details");
    await expect(source.locator("pre")).toBeHidden();
    await source.getByText("Show source", { exact: true }).click();
    await expect(source.locator("pre code.language-mermaid")).toContainText("flowchart TD");
    expect(problems).toEqual([]);
  });

  await test.step("The theme switch draws the diagram again", async () => {
    const before = await firstSvg(diagrams()).evaluate((svg) => svg.outerHTML);
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect.poll(() => firstSvg(diagrams()).evaluate((svg) => svg.outerHTML)).not.toBe(before);
    await expect(diagrams()).toHaveCount(2);
    expect(problems).toEqual([]);
  });

  await test.step("Without JavaScript the page has the source: the server's own HTML holds the fences", async () => {
    // What a browser without JavaScript is given. (It may still hide a streamed Suspense
    // boundary behind its fallback, as it does for every page of the app; that is not the
    // diagram's doing, so the HTML is checked, not what the browser shows.)
    const html = await (await page.request.get("/announcements")).text();
    expect(html.match(/<pre><code class="language-mermaid">/g)).toHaveLength(3);
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain("sinnlosMermaid");
  });
});
