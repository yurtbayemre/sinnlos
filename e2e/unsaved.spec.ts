import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * v0.30: a /manage editor with unsaved changes asks before the page is
 * left (a link, a search pick, sign-out, the browser's Back through the
 * Navigation API); Cancel keeps the URL, the text and the session, OK
 * leaves. The skip link and a saved form do not ask. (The bell's prompt is
 * covered in shallow-handlers.test.ts: the fixtures hold no notification.)
 */
test("unsaved changes", async ({ page }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const banner = page.getByRole("banner");
  const title = main.getByRole("textbox", { name: "Title", exact: true });
  const manageLink = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Manage", exact: true });
  const signOut = banner.getByRole("button", { name: "Sign out", exact: true });
  const palette = page.getByRole("dialog", { name: "Global search" });
  const newCourse = "/manage/training/new";
  const onEditor = /\/manage\/training\/new(#main)?$/;
  const text = "E2E Unsaved Course";
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await (accept ? dialog.accept() : dialog.dismiss());
  });
  /** The page asked `asked` times so far, and Cancel kept the editor and its text. */
  const keptAfter = async (asked: number) => {
    await expect.poll(() => dialogs.length).toBe(asked);
    await expect(page).toHaveURL(onEditor);
    await expect(title).toHaveValue(text);
  };
  const pickFromPalette = async () => {
    await page.keyboard.press("Control+k");
    await palette.getByRole("option").first().click();
  };

  await signIn(page, fixtures.users.editor);
  await manageLink.click();
  await main.getByRole("link", { name: "Training", exact: true }).click();
  await main.getByRole("link", { name: "New course", exact: true }).click();
  await expect(page).toHaveURL(newCourse);
  await title.fill(text);

  await test.step("a link, a search pick, sign-out and Back ask; Cancel stays", async () => {
    await manageLink.click();
    await keptAfter(1);

    await pickFromPalette();
    await expect.poll(() => dialogs.length).toBe(2);
    // Cancel keeps the palette open over the editor.
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await keptAfter(2);

    await signOut.click();
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

  await test.step("a saved form leaves without asking", async () => {
    await main.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page).toHaveURL(/\/manage\/training\/(?!new)[^/#]+$/);
    await manageLink.click();
    await expect(page).toHaveURL("/manage");
    expect(dialogs).toHaveLength(4);
  });

  await test.step("OK leaves: a link, Back, a search pick and sign-out", async () => {
    accept = true;
    const dirtyNewCourse = async () => {
      await page.goto(newCourse);
      await title.fill(text);
    };

    await dirtyNewCourse();
    await manageLink.click();
    await expect(page).toHaveURL("/manage");

    await main.getByRole("link", { name: "Training", exact: true }).click();
    await main.getByRole("link", { name: "New course", exact: true }).click();
    await title.fill(text);
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL("/manage/training");

    await dirtyNewCourse();
    await pickFromPalette();
    await expect(page).not.toHaveURL(onEditor);

    await dirtyNewCourse();
    await signOut.click();
    await expect(page).toHaveURL(/\/sign-in/);
    // One prompt per departure: no second (beforeunload) prompt after OK.
    expect(dialogs).toEqual(Array(8).fill("confirm"));
  });
});
