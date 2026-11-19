import { expect, test, type Locator, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * Mermaid in Markdown (v1.1 "Tools"): a ```mermaid fence of a Markdown body is drawn as a
 * diagram wherever the renderer is used (here the editor's preview, the announcements page
 * and a wiki page), and it is part of Markdown, not of the `tools` module. Only a browser
 * can show:
 *   - the Mermaid library is not part of any page without a fence: no JS file of `/` or
 *     of the editor (which bundles the renderer for its preview) holds it, the preview of
 *     a fence loads it;
 *   - a fence draws an SVG in the preview and on the server-rendered pages, and they log no
 *     hydration error;
 *   - a hostile diagram (an `%%{init}%%` that asks for securityLevel "loose", HTML labels,
 *     script and onerror, a click callback, a `javascript:` link, a `themeCSS` with a url())
 *     runs nothing, keeps no handler attribute and no script, and the downgrade does not
 *     take effect: labels stay text (no form, no img), the CSS asks for nothing;
 *   - a sequence message with math, which is HTML whatever htmlLabels says, is drawn as math
 *     without the form, the picture and the table background, the inline style, the SVG fill
 *     and filter, the srcset written beside it: no attribute of the diagram names the host;
 *   - the one request a diagram can still make, the picture of an image shape, carries no
 *     Referer (the (app) layout's `<meta name="referrer" content="same-origin">`, a literal
 *     tag hoisted into `<head>`; the edge's header alone would send the origin);
 *   - a diagram that does not parse stays its source with a hint; a plain fence is as before;
 *   - the drawn diagram has an accessible name and the source one disclosure away;
 *   - the theme switch draws it again, in the other theme's CSS;
 *   - on a wiki page, the ids Mermaid gives a sequence diagram do not take the fragment
 *     target of a heading that slugs the same (`## actor0`);
 *   - for a browser without JavaScript the HTML the server sends holds each fence as the plain
 *     `<pre><code class="language-mermaid">`, never an SVG. The HTML is checked, not what a
 *     browser with JavaScript off shows: it would keep a streamed Suspense boundary behind its
 *     fallback, as it does for every page of the app, whatever the diagram does.
 */
const TITLE = "E2E Mermaid announcement";
const EVIL = "http://evil.invalid:9";
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
  `%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": ".node rect{background:url(${EVIL}/css.png)}"}}%%`,
  "flowchart TD",
  `  A["<form action='${EVIL}/f'><input type=password></form><img src='${EVIL}/label.png' onerror='window.__pwned = 1'><script>window.__pwned = 2</script>"] --> B[Click me]`,
  "  click B call window.__pwned()",
  '  click A href "javascript:window.__pwned = 3"',
  `  P@{ img: "${EVIL}/pixel.png", label: "Pic", pos: "b", w: 40, h: 40, constraint: "on" }`,
  "  B --> P",
  "```",
].join("\n");
// A sequence message with math is HTML whatever htmlLabels says: the label config's tag list
// keeps a form and a picture out of it, the attribute rule everything else that loads (a table's
// background, an inline style or SVG paint with a url(), a srcset).
const MATH = [
  "```mermaid",
  "sequenceDiagram",
  `  A->>B: $$x^2$$<form action='${EVIL}/f'><input type=password></form><img src='${EVIL}/m.png'><span style='background:url(${EVIL}/s.png)' srcset='${EVIL}/ss.png'>s</span><table background='${EVIL}/tbl.png'><tr><td background='${EVIL}/td.png'>c</td></tr></table><svg width='20' height='20'><rect width='20' height='20' fill='url(${EVIL}/fill.svg#a)' filter='url(${EVIL}/filter.svg#a)'/></svg>`,
  "```",
].join("\n");
const BROKEN = ["```mermaid", "flowchart TD", "  A --> --> B ((((", "```"].join("\n");
const PLAIN = ["```js", "const a = 1;", "```"].join("\n");
const BODY = ["Intro text.", PLAIN, FLOW, HOSTILE, MATH, BROKEN].join("\n\n");

const SPACE = "E2E Mermaid space";
const PAGE = "E2E Mermaid page";
// The first lifeline of a sequence diagram gets the id `actor0` from Mermaid; the heading
// below slugs to the same text.
const WIKI_BODY = [
  "Intro text.",
  ["```mermaid", "sequenceDiagram", "  A->>B: hello", "```"].join("\n"),
  "## actor0",
  "A heading with the slug of an id Mermaid gives the diagram above.",
].join("\n\n");

const ERROR_HINT = "This diagram could not be drawn. Its source is shown instead.";
/** A string only the Mermaid library holds (its answer to a text over maxTextSize). */
const MERMAID_MARK = "Maximum text size in diagram exceeded";
/** A hydration mismatch, in React's own words (development) and as the production build says it. */
const HYDRATION = /hydrat|Minified React error #(418|419|422|423|425)\b/i;
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Hydration errors and uncaught errors, and the dialogs a page opened (none may run). */
function watchPage(page: Page) {
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
  return { problems, dialogs };
}

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

/** The requests to the evil host, answered with a picture, and the Referer each carried. */
async function answerEvil(page: Page) {
  const requests: { url: string; referer: string | undefined }[] = [];
  await page.route(`${EVIL}/**`, (route) => {
    requests.push({ url: route.request().url(), referer: route.request().headers()["referer"] });
    return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });
  return requests;
}

/** The first SVG of `groups`. */
const firstSvg = (groups: Locator) => groups.first().locator("svg").first();

/** Nothing of a hostile diagram is left in `group`, and nothing ran. */
async function expectInert(page: Page, group: Locator, dialogs: string[]) {
  await expect(group.locator("script, [onerror], [onclick], [onload], [onmouseover]")).toHaveCount(
    0,
  );
  await expect(group.locator('a[href^="javascript:" i], a[href^="data:" i]')).toHaveCount(0);
  // Labels are SVG text, and the label sanitizer removes the form and the picture from
  // them (in the built app the hostile label is drawn empty): no element of them is left.
  await expect(group.locator("form, input, img, foreignObject")).toHaveCount(0);
  await group.getByText("Click me", { exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
    undefined,
  );
  expect(dialogs).toEqual([]);
}

/**
 * The math message is drawn as math; the form, the picture and every attribute that named
 * the evil host (a table background, an inline style, an SVG fill, a srcset) are gone.
 */
async function expectMathOnly(group: Locator) {
  await expect(group.locator("math")).toHaveCount(1);
  await expect(group.locator("form, input, img, button")).toHaveCount(0);
  const naming = await group.evaluate((element) =>
    [element, ...element.querySelectorAll("*")].flatMap((node) =>
      [...node.attributes]
        .filter((attribute) => attribute.value.includes("evil.invalid"))
        .map((attribute) => attribute.name),
    ),
  );
  expect(naming).toEqual([]);
}

test("mermaid-in-markdown", async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const { problems, dialogs } = watchPage(page);
  const evil = await answerEvil(page);
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
    await expect(diagrams()).toHaveCount(3);
    await expect(firstSvg(diagrams())).toBeVisible();
    expect(await mermaidLoaded(), "a fence did not load Mermaid").toBe(true);

    await expect(main.getByText(ERROR_HINT, { exact: true })).toBeVisible();
    await expect(
      preview.locator("pre code.language-mermaid", { hasText: "A --> --> B ((((" }),
    ).toBeVisible();
    await expect(preview.locator("pre code.language-js")).toHaveText("const a = 1;\n");
    await expectInert(page, diagrams().nth(1), dialogs);
    await expectMathOnly(diagrams().nth(2));
    expect(problems).toEqual([]);
  });

  await test.step("The picture of an image shape is the only request, and it carries no Referer", async () => {
    // Native image shapes fetch their picture while drawing: the document's referrer policy
    // is all that keeps the intranet's origin from the host. The picture in the label, the
    // form's action, the CSS url() and the picture, form and styled span of the math
    // message are never requested.
    await expect.poll(() => evil.length).toBeGreaterThan(0);
    expect(evil.filter((request) => !request.url.endsWith("/pixel.png"))).toEqual([]);
    expect(evil.filter((request) => request.referer !== undefined)).toEqual([]);
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
    await expect(diagrams()).toHaveCount(3);
    await expect(main.getByText(ERROR_HINT, { exact: true })).toBeVisible();
    // The diagram's own title names the SVG, the group names the others.
    await expect(diagrams().first().locator("svg title")).toHaveText("Delivery flow");
    await expect(diagrams().first().locator("svg")).toHaveAttribute("aria-labelledby", /.+/);
    await expectInert(page, diagrams().nth(1), dialogs);
    await expectMathOnly(diagrams().nth(2));
    expect(evil.filter((request) => request.referer !== undefined)).toEqual([]);

    const source = diagrams().first().locator("details");
    await expect(source.locator("pre")).toBeHidden();
    await source.getByText("Show source", { exact: true }).click();
    await expect(source.locator("pre code.language-mermaid")).toContainText("flowchart TD");
    expect(problems).toEqual([]);
  });

  await test.step("The theme switch draws the diagram again, in the other theme's CSS", async () => {
    // The ids change with every render, so the CSS is compared without them.
    const css = async () =>
      ((await firstSvg(diagrams()).locator("style").first().textContent()) ?? "").replace(
        /sinnlosMermaid\d+/g,
        "ID",
      );
    const before = await css();
    expect(before).not.toBe("");
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect.poll(css).not.toBe(before);
    await expect(diagrams()).toHaveCount(3);
    expect(problems).toEqual([]);
  });

  await test.step("Without JavaScript the page has the source: the server's own HTML holds the fences", async () => {
    const html = await (await page.request.get("/announcements")).text();
    expect(html.match(/<pre><code class="language-mermaid">/g)).toHaveLength(4);
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain("sinnlosMermaid");
  });
});

test("mermaid-in-wiki-page", async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const { problems } = watchPage(page);
  const diagrams = () => main.getByRole("group", { name: "Diagram", exact: true });

  await test.step("An editor makes a space and publishes a page with a sequence diagram", async () => {
    await signIn(page, fixtures.users.editor);
    await page.goto("/manage/wiki/new");
    await main.getByRole("textbox", { name: "Name", exact: true }).fill(SPACE);
    await main.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\/wiki\/(?!new$)[^/]+$/);
    await main.getByRole("link", { name: "New page", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/[^/]+\/new\?create=1$/);
    await main.getByRole("textbox", { name: "Title", exact: true }).fill(PAGE);
    await main.getByRole("textbox", { name: "Text", exact: true }).fill(WIKI_BODY);
    await main.getByRole("button", { name: "Publish", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Publish now?", exact: true })
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /^(Created and published|Published)\.$/ }),
    ).toBeVisible();
    await main.getByRole("link", { name: "View page", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki\/[^/?]+\/[^/?]+$/);
  });

  await test.step("The wiki page draws it after a clean hydration; the heading keeps its fragment target", async () => {
    await expect(main.getByRole("heading", { name: "actor0", exact: true })).toBeVisible();
    await expect(diagrams()).toHaveCount(1);
    await expect(firstSvg(diagrams())).toBeVisible();
    // The heading, not the diagram's first lifeline, is what `#actor0` leads to.
    expect(await page.evaluate(() => document.getElementById("actor0")?.tagName)).toBe("H2");
    const ids = await diagrams()
      .first()
      .locator("[id]")
      .evaluateAll((elements) => elements.map((element) => element.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !id.includes("sinnlosMermaid"))).toEqual([]);
    expect(problems).toEqual([]);
  });

  await test.step("The wiki page's HTML holds the fence as plain source, which is all a browser without JavaScript gets", async () => {
    const html = await (await page.request.get(page.url())).text();
    expect(html.match(/<pre><code class="language-mermaid">/g)).toHaveLength(1);
    expect(html).toContain("sequenceDiagram");
    expect(html).not.toContain("sinnlosMermaid");
  });
});
