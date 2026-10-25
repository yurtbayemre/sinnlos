import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * v0.30: a /manage editor with unsaved changes asks before the page is
 * left (a link, a search pick, sign-out, the browser's Back through the
 * Navigation API), and Cancel keeps the URL, the text and the session. The
 * skip link and a saved form do not ask; OK leaves.
 */
test("unsaved changes", async ({ page }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const banner = page.getByRole("banner");
  const title = main.getByRole("textbox", { name: "Title", exact: true });
  const manageLink = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Manage", exact: true });
  const onEditor = /\/manage\/training\/new(#main)?$/;
  const text = "E2E Unsaved Course";
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await (accept ? dialog.accept() : dialog.dismiss());
  });
  /** The page asked once more, and Cancel kept the editor and its text. */
  const keptAfter = async (asked: number) => {
    await expect.poll(() => dialogs.length).toBe(asked);
    await expect(page).toHaveURL(onEditor);
    await expect(title).toHaveValue(text);
  };

  await signIn(page, fixtures.users.editor);
  await manageLink.click();
  await main.getByRole("link", { name: "Training", exact: true }).click();
  await main.getByRole("link", { name: "New course", exact: true }).click();
  await expect(page).toHaveURL(onEditor);
  await title.fill(text);

  await test.step("a link, a search pick, sign-out and Back ask; Cancel stays", async () => {
    await manageLink.click();
    await keptAfter(1);

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await palette.getByRole("option").first().click();
    await keptAfter(2);
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");

    await banner.getByRole("button", { name: "Sign out", exact: true }).click();
    await keptAfter(3);
    await expect(banner.getByText(fixtures.users.editor.email, { exact: true })).toBeVisible();

    await page.evaluate(() => history.back());
    await keptAfter(4);
  });

  await test.step("the skip link does not ask", async () => {
    await page.getByRole("link", { name: "Skip to content", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    expect(dialogs).toHaveLength(4);
  });

  await test.step("a saved form leaves without asking; OK leaves a changed one", async () => {
    await main.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\/training\/(?!new)[^/#]+$/);
    const saved = page.url();
    await manageLink.click();
    await expect(page).toHaveURL("/manage");
    expect(dialogs).toHaveLength(4);

    await page.goto(saved);
    await title.fill(`${text} changed`);
    accept = true;
    await manageLink.click();
    await expect(page).toHaveURL("/manage");
    expect(dialogs).toEqual(["confirm", "confirm", "confirm", "confirm", "confirm"]);
  });
});
