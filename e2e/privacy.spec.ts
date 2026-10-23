import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { loadFixtures, signInAndEnroll } from "./helpers";

/**
 * v0.28 data protection, end to end: an admin blocks a leaver (who drops
 * out of the directory but keeps the attribution of their comment), exports
 * their data (Art. 15) and anonymises them (Art. 17); the comment then shows
 * the neutral name and the account cannot be edited any more.
 */
test("block-export-anonymise", async ({ page }) => {
  test.setTimeout(150_000);
  const fixtures = loadFixtures();
  const leaver = fixtures.users.leaver;
  const userPage = `/manage/users/${leaver.id}`;
  const comment = () => page.getByText(fixtures.privacy.comment, { exact: true });

  await test.step("The admin enrolls; the leaver is listed and named on their comment", async () => {
    await signInAndEnroll(page, fixtures.users.privacy);
    await page.goto("/people");
    await expect(
      page.getByRole("main").getByText("E2E leaver", { exact: true }).first(),
    ).toBeVisible();
    await page.goto("/announcements");
    await expect(comment()).toBeVisible();
    await expect(
      page.getByRole("main").getByText("E2E leaver", { exact: true }).first(),
    ).toBeVisible();
  });

  await test.step("Blocked: gone from the directory, the comment keeps the name", async () => {
    await page.goto(userPage);
    await page.getByLabel("Account blocked", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Anonymise …", exact: true })).toBeVisible();
    await page.goto("/people");
    await expect(page.getByRole("main").getByText("E2E leaver", { exact: true })).toHaveCount(0);
    await page.goto("/announcements");
    await expect(
      page.getByRole("main").getByText("E2E leaver", { exact: true }).first(),
    ).toBeVisible();
  });

  await test.step("The export downloads everything stored about the person", async () => {
    await page.goto(userPage);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export data (JSON)", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^sinnlos-export-e2e-leaver-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await readFile((await file.path())!, "utf8"));
    expect(data.account.email).toBe(leaver.email);
    expect(JSON.stringify(data.content.comments)).toContain(fixtures.privacy.comment);
    expect(Array.isArray(data.notIncluded)).toBe(true);
  });

  await test.step("Anonymised with the typed username", async () => {
    await page.getByRole("button", { name: "Anonymise …", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByLabel("Type the username to confirm: e2e-leaver", { exact: true });
    await expect(confirm).toBeVisible();
    const run = dialog.getByRole("button", { name: "Anonymise for good", exact: true });
    await expect(run).toBeDisabled();
    await confirm.fill("e2e-leaver");
    await run.click();
    await expect(page.getByText(/^Anonymised on /)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/^Anonymised on /)).toBeVisible();
    await expect(page.getByLabel("Account blocked", { exact: true })).toHaveCount(0);
  });

  await test.step("The comment stays, under the neutral name", async () => {
    await page.goto("/announcements");
    await expect(comment()).toBeVisible();
    await expect(page.getByRole("main").getByText("Former person", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText("E2E leaver", { exact: true })).toHaveCount(0);
  });
});
