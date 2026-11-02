import { expect, test, type Browser, type Page } from "@playwright/test";
import { loadFixtures, signIn, sql, type Account } from "./helpers";

/**
 * v0.36 secret sharing by role. This run sets the lists for the cms and
 * the web (run.mjs): SECRETS_SEND_ROLES=department_head,team_lead,member and
 * SECRETS_RECEIVE_ROLES=team_lead,member. Editors neither send nor receive,
 * department heads only send; secrets.spec.ts (member to lead) is unchanged.
 * A list change needs a restart, so a role change in the database (the
 * run's psql) puts a person outside a list instead: the cms and the web
 * read the role fresh on every request, as they read the lists. The roles
 * are put back at the end for the specs that follow.
 */

const NAV = "Main navigation";

async function signedIn(browser: Browser, account: Account) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, account);
  return page;
}

/** Moves a fixture user to the role `type`. */
function setRole(email: string, type: string) {
  expect(
    sql(
      `UPDATE up_users_role_lnk SET role_id = (SELECT id FROM up_roles WHERE type = '${type}') ` +
        `WHERE user_id = (SELECT id FROM up_users WHERE email = '${email}') RETURNING role_id`,
    ),
    `${email} -> ${type}`,
  ).toMatch(/^\d+$/);
}

/** Sends `text` to the member through /secrets/new; resolves the share's id. */
async function sendToMember(page: Page, text: string): Promise<string> {
  await page.goto("/secrets/new");
  await page.getByPlaceholder("Search for a colleague...").fill("E2E member");
  await page.getByRole("button", { name: "E2E member", exact: false }).click();
  await page.getByLabel("Secret", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send secret", exact: true }).click();
  await expect(page).toHaveURL(/\/secrets\/[a-z0-9]{24}$/);
  return page.url().split("/").pop()!;
}

test("secret-roles", async ({ browser }) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const { lead: leadAccount, member: memberAccount, editor: editorAccount } = fixtures.users;
  const secret = (n: number) => `e2e-role-${n}-${fixtures.runId.slice(-8)}`;
  const lead = await signedIn(browser, leadAccount);
  const member = await signedIn(browser, memberAccount);
  const editor = await signedIn(browser, editorAccount);
  try {
    await test.step("A lead sends, a member receives and opens", async () => {
      const id = await sendToMember(lead, secret(1));
      await member.goto("/secrets");
      await member.getByRole("link", { name: "Secret from E2E lead" }).click();
      await expect(member).toHaveURL(`/secrets/${id}`);
      await member.getByRole("button", { name: "Show and delete" }).click();
      await expect(member.getByTestId("secret-text")).toHaveText(secret(1));
    });

    await test.step("Outside both lists: no menu entry, no button, the role page on /secrets/new", async () => {
      await editor.goto("/");
      const nav = editor.getByRole("navigation", { name: NAV });
      await expect(nav.getByRole("link", { name: "Events", exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Secrets", exact: true })).toHaveCount(0);
      await editor.goto("/secrets");
      await expect(editor.getByRole("heading", { name: "Sent by you" })).toBeVisible();
      await expect(editor.getByRole("heading", { name: "For you" })).toHaveCount(0);
      await expect(editor.getByRole("link", { name: "New secret" })).toHaveCount(0);
      await editor.goto("/secrets/new");
      await expect(editor.getByText("Not available for your account")).toBeVisible();
      await expect(editor.getByRole("button", { name: "Send secret" })).toHaveCount(0);
    });

    let pending = "";
    await test.step("Receiving restricted: the bell link shows the secret as not available", async () => {
      pending = await sendToMember(lead, secret(2));
      // Department heads send but do not receive in this run.
      setRole(memberAccount.email, "department_head");
      await member.goto("/");
      await member.getByRole("button", { name: /^Notifications, \d+ unread/ }).click();
      await member
        .getByRole("menuitem", { name: /E2E lead sent you a secret/ })
        .first()
        .click();
      await expect(member).toHaveURL(`/secrets/${pending}`);
      await expect(member.getByText(/cannot be opened right now/)).toBeVisible();
      await expect(member.getByRole("button", { name: "Show and delete" })).toHaveCount(0);
      await member.goto("/secrets");
      await expect(member.getByRole("heading", { name: "For you" })).toHaveCount(0);
      await expect(member.getByRole("link", { name: "New secret" })).toBeVisible();
    });

    await test.step("A lead who lost both rights revokes the pending secret through /secrets", async () => {
      setRole(leadAccount.email, "editor");
      await lead.goto("/");
      const nav = lead.getByRole("navigation", { name: NAV });
      await expect(nav.getByRole("link", { name: "Events", exact: true })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Secrets", exact: true })).toHaveCount(0);
      await lead.goto("/secrets");
      await expect(lead.getByRole("link", { name: "New secret" })).toHaveCount(0);
      await lead.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(lead.getByText(/^Revoked /)).toBeVisible();
      await lead.goto(`/secrets/${pending}`);
      await expect(lead.getByText(/^Revoked /)).toBeVisible();
    });
  } finally {
    setRole(memberAccount.email, "member");
    setRole(leadAccount.email, "team_lead");
    for (const page of [lead, member, editor]) await page.context().close();
  }
});
