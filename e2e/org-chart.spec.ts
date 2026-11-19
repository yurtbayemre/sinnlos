import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * The org chart's department view (v1.1 "Tools"): a member reaches it from the Tools hub,
 * switches between the two views by link (so the URL is the state), and reads department,
 * team, lead and member count as nested lists. A guest gets the reporting-line chart
 * without a switch and an explanation instead of the department view. The fixtures:
 * "E2E Department" holds the editable team (lead and two members) and the read-only team
 * (no lead, one member); "E2E Other Department" has no teams.
 */
test("org-chart-departments-view", async ({ page, browser }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const views = main.getByRole("group", { name: "View", exact: true });

  await test.step("A member opens the view from the Tools hub", async () => {
    await signIn(page, fixtures.users.member);
    await page.goto("/tools");
    await main.getByRole("link", { name: /Departments in the org chart/ }).click();
    await expect(page).toHaveURL("/people/org-chart?view=departments");
    await expect(page.getByRole("heading", { name: "Org chart", level: 1 })).toBeVisible();
    await expect(views.getByRole("link", { name: "Departments", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      views.getByRole("link", { name: "Reporting lines", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  await test.step("Department, team, lead and member count are in nested lists", async () => {
    const department = main.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "E2E Department", level: 2, exact: true }),
    });
    const teamOf = (name: string) =>
      department.getByRole("listitem").filter({
        has: page.getByRole("heading", { name, level: 3, exact: true }),
      });

    const editable = teamOf(fixtures.teams.editable.name);
    await expect(editable.getByText("Team lead:")).toBeVisible();
    await expect(editable.getByRole("link", { name: "E2E lead", exact: true })).toBeVisible();
    await expect(editable.getByText("2 members", { exact: true })).toBeVisible();

    const readonly = teamOf(fixtures.teams.readonly.name);
    await expect(readonly.getByText("No team lead set", { exact: true })).toBeVisible();
    await expect(readonly.getByText("1 member", { exact: true })).toBeVisible();

    const other = main.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "E2E Other Department", level: 2, exact: true }),
    });
    await expect(other.getByText("No head set", { exact: true })).toBeVisible();
    await expect(other.getByText("No teams", { exact: true })).toBeVisible();
  });

  await test.step("The switch goes back to the reporting lines, and the URL is the state", async () => {
    await views.getByRole("link", { name: "Reporting lines", exact: true }).click();
    await expect(page).toHaveURL("/people/org-chart");
    await expect(views.getByRole("link", { name: "Reporting lines", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.goBack();
    await expect(page).toHaveURL("/people/org-chart?view=departments");
    await expect(main.getByRole("heading", { name: "E2E Department", level: 2 })).toBeVisible();
  });

  await test.step("A guest gets the reporting lines without a switch, and an explanation for the view", async () => {
    const context = await browser.newContext();
    try {
      const guest = await context.newPage();
      await signIn(guest, fixtures.users.guest);
      await guest.goto("/people/org-chart");
      await expect(guest.getByRole("heading", { name: "Org chart", level: 1 })).toBeVisible();
      await expect(guest.getByRole("group", { name: "View", exact: true })).toHaveCount(0);

      await guest.goto("/people/org-chart?view=departments");
      await expect(guest.getByText("Not available for your account")).toBeVisible();
      await expect(guest.getByRole("heading", { name: "E2E Department" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
