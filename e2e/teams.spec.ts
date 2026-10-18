import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn, type Account, type Team } from "./helpers";

async function signInAndOpenTeam(page: Page, account: Account, team: Team) {
  await signIn(page, account);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Teams", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Teams", level: 1, exact: true })).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link")
    .filter({ has: page.getByRole("heading", { name: team.name, level: 2, exact: true }) })
    .click();
  await expect(page).toHaveURL(`/teams/${team.slug}`);
  await expect(page.getByRole("heading", { name: team.name, level: 1, exact: true })).toBeVisible();
}

test("teams-edit-description", async ({ page, browser }) => {
  const fixtures = loadFixtures();
  const team = fixtures.teams.editable;
  const description = `Updated team description for ${fixtures.runId}.`;

  await test.step("Lead signs in and saves a new description", async () => {
    await signInAndOpenTeam(page, fixtures.users.lead, team);
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await expect(page).toHaveURL(`/teams/${team.slug}/edit`);
    await expect(page.getByRole("heading", { name: "Edit team", level: 1 })).toBeVisible();
    const field = page.getByRole("textbox", { name: "Description", exact: true });
    await expect(field).toHaveValue(team.description);
    await field.fill(description);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved.");
  });

  await test.step("Reload and team details show the saved description", async () => {
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
      description,
    );
    await page.getByRole("link", { name: "Back to details", exact: true }).click();
    await expect(page).toHaveURL(`/teams/${team.slug}`);
    await expect(page.getByRole("main").getByText(description, { exact: true })).toBeVisible();
  });

  await test.step("Member reads the saved description in a separate session", async () => {
    const memberContext = await browser.newContext();
    try {
      const memberPage = await memberContext.newPage();
      await signInAndOpenTeam(memberPage, fixtures.users.member, team);
      await expect(
        memberPage.getByRole("main").getByText(description, { exact: true }),
      ).toBeVisible();
    } finally {
      await memberContext.close();
    }
  });
});

test("teams-member-read-only", async ({ page }) => {
  const fixtures = loadFixtures();
  const team = fixtures.teams.readonly;
  const main = page.getByRole("main");

  await test.step("Member can read the team but has no edit link", async () => {
    await signInAndOpenTeam(page, fixtures.users.member, team);
    await expect(main.getByText(team.description, { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  });

  await test.step("Direct editor navigation shows the not-found view", async () => {
    await page.goto(`/teams/${team.slug}/edit`);
    await expect(page).toHaveURL(`/teams/${team.slug}/edit`);
    await expect(main.getByText("Page not found", { exact: true })).toBeVisible();
    await expect(
      main.getByText("The page you requested does not exist or has moved.", { exact: true }),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: "Back to dashboard", exact: true })).toBeVisible();
    await expect(main.getByRole("textbox", { name: "Description", exact: true })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  await test.step("Returning to the team shows the unchanged description", async () => {
    await page.goto(`/teams/${team.slug}`);
    await expect(
      main.getByRole("heading", { name: team.name, level: 1, exact: true }),
    ).toBeVisible();
    await expect(main.getByText(team.description, { exact: true })).toBeVisible();
  });
});
