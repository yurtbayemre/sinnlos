import { expect, test, type Browser, type Page } from "@playwright/test";
import { loadFixtures, signIn, sql } from "./helpers";

/**
 * v0.35 secret sharing in the browser: a member sends secrets to the team
 * lead. The lead's bell shows the notification (live events are off in
 * the ordinary run: it appears on the next page load; `secret-live` runs
 * alone with them on, `test:live`); the page and its RSC hold no text
 * before or after "Show and delete", every /secrets answer is no-store;
 * the text appears once, in one tab only, and never again (reload,
 * back/forward, the losing one of two concurrent sessions, a late answer
 * after navigating away); revoke and expiry end a share; a cross-origin
 * Server Action is refused; a guest has no secrets. The expiry is moved in
 * the database (the run's psql), the one change a browser cannot make; the
 * cms then refuses before it decrypts.
 */

const GONE = "This secret has already been opened, revoked or has expired.";
const LOST = /already been opened, revoked or has expired|could not be confirmed/;
const NO_STORE = /^(?=.*\bprivate\b)(?=.*\bno-store\b)/;

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

  await test.step("Every /secrets answer is private, no-store: redirect, 404", async () => {
    const anonymous = await browser.newContext();
    const redirect = await anonymous.request.get("/secrets", { maxRedirects: 0 });
    expect(redirect.status()).toBe(307);
    expect(redirect.headers()["cache-control"]).toMatch(NO_STORE);
    await anonymous.close();
    // The not-found view (the status can be a streamed 200, see teams.spec.ts).
    for (const path of ["/secrets/aaaaaaaaaaaaaaaaaaaaaaaa", "/secrets/not-an-id"]) {
      const missing = await lead.goto(path);
      expect(missing?.headers()["cache-control"], path).toMatch(NO_STORE);
      await expect(lead.getByText("Page not found", { exact: true })).toBeVisible();
    }
  });

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
  let winner = lead;
  await test.step("No text before the click; of two concurrent sessions exactly one gets it", async () => {
    const response = await second.goto(`/secrets/${first}`);
    expect(response?.headers()["cache-control"]).toMatch(NO_STORE);
    expect(await response?.text()).not.toContain(secret(1));
    await expect(lead.getByRole("button", { name: "Show and delete" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Show and delete" })).toBeVisible();
    const request = lead.waitForRequest(
      (r) => r.method() === "POST" && !!r.headers()["next-action"],
    );
    await Promise.all(
      [lead, second].map((page) => page.getByRole("button", { name: "Show and delete" }).click()),
    );
    actionId = (await request).headers()["next-action"]!;
    const got = await Promise.all(
      [lead, second].map(async (page) => {
        const text = page.getByTestId("secret-text");
        await expect(text.or(page.getByRole("alert").filter({ hasText: LOST }))).toBeVisible();
        return (await text.count()) === 1;
      }),
    );
    expect(got.filter(Boolean)).toHaveLength(1);
    winner = got[0] ? lead : second;
    await expect(winner.getByTestId("secret-text")).toHaveText(secret(1));
  });

  await test.step("Reload, RSC, back and forward show no text; the sender sees retrieved", async () => {
    const rsc = await winner.request.get(`/secrets/${first}`, { headers: { RSC: "1" } });
    expect(rsc.headers()["cache-control"]).toMatch(NO_STORE);
    expect(await rsc.text()).not.toContain(secret(1));
    await winner.getByRole("link", { name: "All secrets" }).click();
    await expect(winner).toHaveURL("/secrets");
    await winner.goBack();
    // Next's router may restore its copy of the page from before the
    // click: never the text, which lived in the component's state only.
    await expect(winner.getByRole("heading", { name: "Secret from E2E member" })).toBeVisible();
    await expect(winner.getByTestId("secret-text")).toHaveCount(0);
    expect(await winner.content()).not.toContain(secret(1));
    await winner.goForward();
    await winner.goBack();
    await winner.reload();
    await expect(winner.getByText(/^Retrieved /)).toBeVisible();
    expect(await winner.content()).not.toContain(secret(1));
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
    // The destination has rendered before the answer is let through.
    await expect(lead).toHaveURL("/secrets");
    await expect(lead.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
    const finished = lead.waitForEvent("requestfinished", (r) => r.method() === "POST");
    release();
    await finished;
    await expect(lead.getByRole("heading", { name: "Secrets", exact: true })).toBeVisible();
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

/**
 * The isolated live-events run (`pnpm --filter @sinnlos/e2e test:live`):
 * the lead's open page gets the notification by a ping on its open stream,
 * and the bell changes without a reload, long before its 120-second poll.
 */
test("secret-live", async ({ browser }) => {
  test.skip(process.env.SINNLOS_E2E_LIVE !== "1", "runs in the live-events run (test:live)");
  const fixtures = loadFixtures();
  const sender = await contextFor(browser);
  const lead = await contextFor(browser);
  await signIn(sender, fixtures.users.member);
  await signIn(lead, fixtures.users.lead);
  // Records the stream's hello and ping events of the lead's page.
  await lead.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __livePings: seen });
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        for (const type of ["hello", "ping"]) {
          this.addEventListener(type, (event) =>
            seen.push(`${type} ${(event as MessageEvent).data}`),
          );
        }
      }
    };
  });
  const events = () =>
    lead.evaluate(() => (window as unknown as { __livePings: string[] }).__livePings);
  await lead.goto("/");
  await expect.poll(async () => (await events()).some((e) => e.startsWith("hello"))).toBe(true);
  let loads = 0;
  lead.on("load", () => (loads += 1));
  const bell = lead.getByRole("button", { name: /^Notifications/ });
  const before = await bell.getAttribute("aria-label");

  await send(sender, `e2e-live-${fixtures.runId.slice(-8)}`);
  await expect
    .poll(async () => (await events()).some((e) => e.startsWith("ping")), { timeout: 10_000 })
    .toBe(true);
  await expect(bell).not.toHaveAttribute("aria-label", before ?? "", { timeout: 10_000 });
  expect(loads).toBe(0);
  await bell.click();
  await expect(lead.getByRole("menuitem", { name: /E2E member sent you a secret/ })).toBeVisible();
  for (const page of [sender, lead]) await page.context().close();
});
