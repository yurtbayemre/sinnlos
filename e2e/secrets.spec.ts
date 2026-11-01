import { expect, test, type Browser, type Page } from "@playwright/test";
import { loadFixtures, signIn, sql } from "./helpers";

/**
 * v0.35 secret sharing in the browser: a member sends secrets to the team
 * lead. The lead's bell shows the notification (live events are off in
 * this harness: it appears on the next page load); the page
 * shows no text before "Show and delete"; the text appears once, in that
 * tab only, and never again (reload, back/forward, a second session, a
 * late answer after navigating away); revoke and expiry end a share; a
 * cross-origin Server Action is refused; a guest has no secrets. The
 * expiry is moved in the database (the run's psql), the one change a
 * browser cannot make; the cms then refuses before it decrypts.
 */

const GONE = "This secret has already been opened, revoked or has expired.";

/** Sends `text` to the lead through /secrets/new; resolves the share's id. */
async function send(page: Page, text: string): Promise<string> {
  await page.goto("/secrets/new");
  await page.getByPlaceholder("Search for a colleague...").fill("E2E lead");
  await page.getByRole("button", { name: "E2E lead", exact: false }).click();
  await page.getByLabel("Secret", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send secret", exact: true }).click();
  await expect(page).toHaveURL(/\/secrets\/[a-z0-9]{24}$/);
  await expect(page.getByText(/^Not opened yet, expires /)).toBeVisible();
  return page.url().split("/").pop()!;
}

async function contextFor(browser: Browser, from?: Page) {
  const context = await browser.newContext(
    from ? { storageState: await from.context().storageState() } : {},
  );
  return context.newPage();
}

test("secret-sharing", async ({ browser }) => {
  test.setTimeout(180_000);
  const fixtures = loadFixtures();
  const marker = fixtures.runId.slice(-8);
  const secret = (n: number) => `e2e-secret-${n}-${marker}`;
  const sender = await contextFor(browser);
  const lead = await contextFor(browser);
  await signIn(sender, fixtures.users.member);
  await signIn(lead, fixtures.users.lead);

  let first = "";
  await test.step("Sent: the lead's bell links to it", async () => {
    first = await send(sender, secret(1));
    await lead.reload();
    await lead.getByRole("button", { name: /^Notifications, \d+ unread/ }).click();
    await lead
      .getByRole("menuitem", { name: /E2E member sent you a secret/ })
      .first()
      .click();
    await expect(lead).toHaveURL(`/secrets/${first}`);
  });

  const second = await contextFor(browser, lead);
  let actionId = "";
  await test.step("No text before the click; one session gets it once, the other loses", async () => {
    const response = await second.goto(`/secrets/${first}`);
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(await response?.text()).not.toContain(secret(1));
    await expect(lead.getByRole("button", { name: "Show and delete" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Show and delete" })).toBeVisible();
    const request = lead.waitForRequest(
      (r) => r.method() === "POST" && !!r.headers()["next-action"],
    );
    await lead.getByRole("button", { name: "Show and delete" }).click();
    actionId = (await request).headers()["next-action"]!;
    await expect(lead.getByTestId("secret-text")).toHaveText(secret(1));
    await second.getByRole("button", { name: "Show and delete" }).click();
    await expect(second.getByRole("alert").filter({ hasText: GONE })).toBeVisible();
    await expect(second.getByTestId("secret-text")).toHaveCount(0);
  });

  await test.step("Reload, back and forward show no text; the sender sees retrieved", async () => {
    await lead.getByRole("link", { name: "All secrets" }).click();
    await expect(lead).toHaveURL("/secrets");
    await lead.goBack();
    // Next's router may restore its copy of the page from before the
    // click: never the text, which lived in the component's state only.
    await expect(lead.getByRole("heading", { name: "Secret from E2E member" })).toBeVisible();
    await expect(lead.getByTestId("secret-text")).toHaveCount(0);
    expect(await lead.content()).not.toContain(secret(1));
    await lead.goForward();
    await lead.goBack();
    await lead.reload();
    await expect(lead.getByText(/^Retrieved /)).toBeVisible();
    expect(await lead.content()).not.toContain(secret(1));
    await sender.reload();
    await expect(sender.getByText(/^Retrieved /)).toBeVisible();
  });

  await test.step("A cross-origin Server Action is refused; the same call from the site works", async () => {
    const id = await send(sender, secret(2));
    const call = (origin: string) =>
      lead.request.post(`/secrets/${id}`, {
        headers: { "next-action": actionId, origin, "content-type": "text/plain;charset=UTF-8" },
        data: JSON.stringify([id]),
      });
    const refused = await call("http://evil.example");
    expect(refused.status()).not.toBe(200);
    expect(await refused.text()).not.toContain(secret(2));
    const allowed = await call(new URL(lead.url()).origin);
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toContain(secret(2));
  });

  await test.step("Revoked while the lead's page is open: nothing to open", async () => {
    const id = await send(sender, secret(3));
    await lead.goto(`/secrets/${id}`);
    await sender.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(sender.getByText(/^Revoked /)).toBeVisible();
    await lead.getByRole("button", { name: "Show and delete" }).click();
    await expect(lead.getByRole("alert").filter({ hasText: GONE })).toBeVisible();
  });

  await test.step("Expired while the lead's page is open: the cms refuses it", async () => {
    const id = await send(sender, secret(4));
    await lead.goto(`/secrets/${id}`);
    expect(
      sql(
        `UPDATE secret_shares SET expires_at = now() - interval '1 minute' WHERE document_id = '${id}' RETURNING state`,
      ),
    ).toBe("pending");
    await lead.getByRole("button", { name: "Show and delete" }).click();
    await expect(lead.getByRole("alert").filter({ hasText: GONE })).toBeVisible();
    await lead.reload();
    await expect(lead.getByText(/cannot be opened right now/)).toBeVisible();
    await expect(lead.getByRole("button", { name: "Show and delete" })).toHaveCount(0);
  });

  await test.step("An answer that arrives after leaving the page is dropped", async () => {
    const id = await send(sender, secret(5));
    await lead.goto(`/secrets/${id}`);
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    let sent = () => {};
    const posted = new Promise<void>((done) => (sent = done));
    await lead.route(`**/secrets/${id}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      sent();
      await held;
      await route.fulfill({ response });
    });
    await lead.getByRole("button", { name: "Show and delete" }).click();
    await posted;
    await lead.getByRole("link", { name: "All secrets" }).click();
    // The answer is held until the page was left (Next may hold the
    // navigation behind the pending action; then it lands right after).
    await lead.waitForTimeout(500);
    release();
    await expect(lead).toHaveURL("/secrets");
    await lead.waitForTimeout(1_000);
    expect(await lead.content()).not.toContain(secret(5));
    await lead.unroute(`**/secrets/${id}`);
    await lead.goto(`/secrets/${id}`);
    await expect(lead.getByText(/^Retrieved /)).toBeVisible();
    expect(await lead.content()).not.toContain(secret(5));
  });

  await test.step("A guest has no secrets", async () => {
    const guest = await contextFor(browser);
    await signIn(guest, fixtures.users.guest);
    const nav = guest.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Secrets", exact: true })).toHaveCount(0);
    await guest.goto("/secrets");
    await expect(guest.getByText("Not available for your account")).toBeVisible();
    await guest.context().close();
  });

  for (const page of [sender, lead, second]) await page.context().close();
});
