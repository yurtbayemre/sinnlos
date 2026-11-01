import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

// v0.34 (audit finding B1): a file under /uploads follows the content it
// belongs to. A signed-in member opens a company-wide document's file and
// gets a 404, like for a file that does not exist, for the file of a
// document meant for another department; a copy in the browser's cache
// does not outlive that (private, no-cache).

/** The status of a same-origin fetch through the browser's HTTP cache. */
const fetchStatus = (page: Page, path: string) =>
  page.evaluate(async (url) => (await fetch(url)).status, path);

test("uploads-follow-their-content", async ({ page, context }) => {
  const fixtures = loadFixtures();
  const otherDepartment = `/uploads/${fixtures.files.otherDepartment}`;

  await test.step("An editor opens another department's file in this browser", async () => {
    await signIn(page, fixtures.users.editor);
    expect(await fetchStatus(page, otherDepartment)).toBe(200);
  });

  await test.step("A member signs in to the same browser", async () => {
    await context.clearCookies();
    await signIn(page, fixtures.users.member);
  });

  await test.step("A company-wide document's file opens, revalidated on every use", async () => {
    const res = await page.request.get(`/uploads/${fixtures.files.companyWide}`);
    expect(res.status()).toBe(200);
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.headers()["cache-control"]).toBe("private, no-cache");
  });

  await test.step("Another department's file is a 404 for the member, cached copy or not", async () => {
    expect(await fetchStatus(page, otherDepartment)).toBe(404);
    expect((await page.request.get(otherDepartment)).status()).toBe(404);
  });
});
