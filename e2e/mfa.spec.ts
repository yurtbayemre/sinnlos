import { expect, test } from "@playwright/test";
import { codeAfter, loadFixtures, signInAndEnroll } from "./helpers";

/**
 * v0.27 mandatory second factor (this run: MFA_REQUIRED_ROLES=admin_role).
 * The admin signs in, is held at /mfa/setup until enrolled, then signs in
 * again with a code of a later time step (each step works once) and once
 * with a recovery code. Few sign-ins on purpose: Strapi throttles
 * /auth/local per IP for the whole suite.
 */
test("mfa-mandatory-enrollment", async ({ page }) => {
  test.setTimeout(150_000);
  const { admin } = loadFixtures().users;

  const enrolled = await test.step("Admin is sent to the setup and enrolls", () =>
    signInAndEnroll(page, admin));
  expect(enrolled.recoveryCodes).toHaveLength(10);

  const signInWith = async (code: string) => {
    await page.context().clearCookies();
    await page.goto("/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(admin.email);
    await page.getByLabel("Password", { exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const codeField = page.getByLabel("Code", { exact: true });
    await expect(codeField).toBeVisible();
    await codeField.fill(code);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("banner").getByText(admin.email, { exact: true })).toBeVisible();
  };

  await test.step("A later code signs in", async () => {
    const { code } = await codeAfter(enrolled.secret, enrolled.step);
    await signInWith(code);
  });

  await test.step("A recovery code signs in", async () => {
    await signInWith(enrolled.recoveryCodes[0]!);
  });
});
