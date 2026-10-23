import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

/**
 * v0.28 FEATURES_OFF: this run switches the marketplace off (run.mjs). Its
 * entry leaves the navigation and its page answers 404; the rest stays.
 */
test("module-switched-off", async ({ page }) => {
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Events", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Marketplace", exact: true })).toHaveCount(0);
  const response = await page.goto("/marketplace");
  expect(response?.status()).toBe(404);
  const events = await page.goto("/events");
  expect(events?.status()).toBe(200);
});
