import { expect, test } from "@playwright/test";
import { loadFixtures, signInAndEnroll } from "./helpers";

/** The run's mailpit (run.mjs), which catches the cms's mails. */
const mailpit = () => {
  const url = process.env.SINNLOS_E2E_MAILPIT;
  if (!url) throw new Error("Run this test through pnpm test:e2e (it needs the run's mailpit).");
  return url;
};

/** The set-password link of the newest mail to `to` (waits for it). */
async function setPasswordLink(to: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        const { messages = [] } = (await search.json()) as { messages?: { ID: string }[] };
        if (messages.length === 0) return "";
        const message = await fetch(`${mailpit()}/api/v1/message/${messages[0]!.ID}`);
        const { Text = "" } = (await message.json()) as { Text?: string };
        link = Text.match(/https?:\/\/\S+\/set-password#\S+/)?.[0] ?? "";
        return link;
      },
      { timeout: 20_000 },
    )
    .not.toBe("");
  return link;
}

/**
 * v0.27 invitation: an admin (second factor first, this run requires it for
 * admins) invites a new person; the mail's link sets the password (the
 * rules are checked), and the new account signs in.
 */
test("invite-set-password-sign-in", async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const email = `invitee-${fixtures.runId.slice(-8)}@e2e.test`;
  const password = `invited-${fixtures.runId.slice(-12)}-pass`;

  await test.step("The admin enrolls and invites one person", async () => {
    await signInAndEnroll(page, fixtures.users.inviter);
    await page.goto("/manage/users/invite");
    await page.getByLabel("E-mail addresses").fill(`${email};E2E Invitee`);
    await page.getByRole("button", { name: "Check the list", exact: true }).click();
    await page.getByRole("button", { name: "Invite 1", exact: true }).click();
    await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible();
  });

  const link = await test.step("The mail carries the link", () => setPasswordLink(email));

  await test.step("The link sets a password that follows the rules", async () => {
    await page.context().clearCookies();
    await page.goto(new URL(link).pathname + new URL(link).hash);
    // The token leaves the address bar at once.
    await expect(page).toHaveURL("/set-password");
    const fill = async (value: string) => {
      await page.getByLabel("New password", { exact: true }).fill(value);
      await page.getByLabel("Repeat the password", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Set password", exact: true }).click();
    };
    await fill("qwerty123456");
    await expect(page.getByRole("alert")).toHaveText(
      "This password is too common. Choose another one.",
    );
    await fill(password);
    await expect(page).toHaveURL("/sign-in?passwordSet=1");
  });

  await test.step("The new member signs in", async () => {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("banner").getByText(email, { exact: true })).toBeVisible();
  });
});
