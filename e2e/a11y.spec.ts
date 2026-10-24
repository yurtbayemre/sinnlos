import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { loadFixtures, signInAndEnroll } from "./helpers";

/**
 * S6 (v0.29): axe's WCAG 2.1 A/AA checks on the main screens, in both
 * themes and in their settled states. These are automated checks, not a
 * conformance claim; keyboard, zoom and screen-reader use are a manual pass.
 *
 * Every violation of the selected tags fails. An exception names its
 * screen, its rule and the reason (EXCEPTIONS).
 *
 * The spec signs in once, as its own admin (users.a11y): it enrolls the
 * second factor (scanning the setup form and the recovery codes), and its
 * session is reused for the rest, so no other spec's user changes state
 * and the auth limiter sees one sign-in.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const EXCEPTIONS: Record<string, Record<string, string>> = {
  // cmdk renders its "no results" text inside its role=listbox (no option
  // child is left); the palette's polite status says "No results" instead.
  "search no results": {
    "aria-required-children": "cmdk keeps the empty listbox; the status announces it",
  },
};

/** Animations and transitions settle colours before axe measures them. */
const STILL = "*,*::before,*::after{transition:none!important;animation:none!important}";

async function scan(page: Page, state: string) {
  await page.addStyleTag({ content: STILL });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${scheme}\\b`));
    const { violations } = await new AxeBuilder({ page })
      .withTags(TAGS)
      .disableRules(Object.keys(EXCEPTIONS[state] ?? {}))
      .analyze();
    const found = violations.map(
      (v) =>
        `${state} (${scheme}): ${v.id} [${v.impact}] ${v.help} — ${v.nodes
          .map((node) => node.target.join(" "))
          .join(" | ")}`,
    );
    expect(found, `${state} (${scheme})`).toEqual([]);
  }
}

let session: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;

test.describe.configure({ mode: "serial" });

test("a11y-anonymous", async ({ page }) => {
  const fixtures = loadFixtures();
  await test.step("Sign-in, empty and after a failed attempt", async () => {
    await page.goto("/sign-in");
    await scan(page, "sign-in");
    await page.getByLabel("Email", { exact: true }).fill(fixtures.users.a11y.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password-0000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await scan(page, "sign-in failed");
  });

  await test.step("Forgot password, before and after", async () => {
    await page.goto("/forgot-password");
    await scan(page, "forgot-password");
    await page.getByLabel("Email", { exact: true }).fill("nobody@e2e.test");
    await page.getByRole("button", { name: "Send link", exact: true }).click();
    const done = page.getByRole("status").filter({ hasText: /./ });
    await expect(done).toBeFocused();
    await scan(page, "forgot-password done");
  });
});

test("a11y-enrollment", async ({ page }) => {
  const fixtures = loadFixtures();
  test.setTimeout(60_000);
  await signInAndEnroll(page, fixtures.users.a11y, async (step) => {
    if (step === "recovery") {
      await expect(page.getByRole("heading", { name: "Your recovery codes" })).toBeFocused();
    }
    await scan(page, `mfa ${step}`);
  });
  session = await page.context().storageState();
});

async function signedIn(context: () => Promise<BrowserContext>): Promise<Page> {
  expect(session, "a11y-enrollment must run first").toBeDefined();
  return (await context()).newPage();
}

test("a11y-app", async ({ browser }) => {
  const fixtures = loadFixtures();
  test.setTimeout(90_000);
  const page = await signedIn(() => browser.newContext({ storageState: session }));
  const main = page.getByRole("main");

  await test.step("Dashboard", async () => {
    await page.goto("/");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await scan(page, "dashboard");
  });

  await test.step("Command palette with and without results", async () => {
    await page.getByRole("button", { name: /^Search/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").fill("E2E");
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(/\d+ results?/);
    await scan(page, "search results");
    await dialog.getByRole("combobox").fill("zzqx-nothing-here");
    await expect(dialog.getByRole("status")).toHaveText("No results");
    await scan(page, "search no results");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("Announcement editor, empty and with a validation error", async () => {
    await page.goto("/manage/announcements/new");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await scan(page, "announcement editor");
    await main.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(main.locator('[aria-invalid="true"]').first()).toBeVisible();
    await scan(page, "announcement editor error");
  });

  await test.step("A dialog: give kudos", async () => {
    await page.goto("/kudos");
    await main.getByRole("button", { name: "Give kudos", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await scan(page, "kudos dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("Lesson player: unanswered, wrong, passed, completed", async () => {
    const { course, lesson } = fixtures.training;
    await page.goto(`/training/${course.slug}/${lesson.documentId}`);
    const https = main.getByRole("group", { name: "Which port is used for HTTPS?", exact: true });
    const phishing = main.getByRole("group", {
      name: "Should you report a phishing email?",
      exact: true,
    });
    const check = main.getByRole("button", { name: "Check answers", exact: true });
    await expect(check).toBeDisabled();
    await scan(page, "lesson unanswered");
    await https.getByRole("radio", { name: "80", exact: true }).check();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).check();
    await check.click();
    await expect(main.getByText("Not quite — try again.", { exact: true })).toBeVisible();
    await scan(page, "lesson wrong answer");
    await https.getByRole("radio", { name: "443", exact: true }).check();
    await check.click();
    // The pass removes the focused button; the outcome takes the focus.
    await expect(main.getByRole("status").filter({ hasText: "All correct!" })).toBeFocused();
    await scan(page, "lesson passed");
    await main.getByRole("button", { name: "Complete lesson", exact: true }).click();
    await expect(main.getByText(/^Completed on .+/)).toBeFocused();
    await scan(page, "lesson completed");
  });

  await test.step("Poll card before and after voting", async () => {
    await page.goto("/polls");
    await expect(main.getByText(fixtures.poll.question, { exact: true })).toBeVisible();
    // The only fixture poll; its first option.
    const pasta = main.getByRole("button", { name: /^Pasta/ });
    await expect(pasta).toBeEnabled();
    await scan(page, "poll");
    await pasta.click();
    await expect(pasta).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByText("Your vote", { exact: true })).toBeVisible();
    await scan(page, "poll voted");
  });

  await page.context().close();
});

/**
 * Part of the manual pass that a browser can repeat: the skip link, the
 * palette's keyboard round trip, arrow keys in a quiz, and 200 % zoom
 * (640 × 360 CSS pixels) without horizontal scrolling, including the
 * mobile navigation's More sheet.
 */
test("a11y-keyboard-and-zoom", async ({ browser }) => {
  const fixtures = loadFixtures();
  const page = await signedIn(() => browser.newContext({ storageState: session }));
  const main = page.getByRole("main");
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  await test.step("Skip link and command palette by keyboard", async () => {
    await page.goto("/");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog").getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  await test.step("Arrow keys move a quiz answer", async () => {
    const { course, lesson } = fixtures.exam;
    await page.goto(`/training/${course.slug}/${lesson.documentId}`);
    const https = main.getByRole("group", { name: "Which port is used for HTTPS?", exact: true });
    await https.getByRole("radio", { name: "80", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(https.getByRole("radio", { name: "80", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowDown");
    await expect(https.getByRole("radio", { name: "443", exact: true })).toBeChecked();
  });

  await test.step("200 % zoom: no horizontal scrolling, More sheet by keyboard", async () => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto("/");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll()).toBe(true);
    const more = page
      .getByRole("navigation", { name: "Bottom navigation", exact: true })
      .getByRole("button", { name: /^More/ });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(more).toBeFocused();
    await page.goto(
      `/training/${fixtures.training.course.slug}/${fixtures.training.lesson.documentId}`,
    );
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll()).toBe(true);
  });

  await page.context().close();
});
