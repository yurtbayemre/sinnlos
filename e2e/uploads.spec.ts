import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

// v0.34 (audit finding B1): a file under /uploads follows the content it
// belongs to. A signed-in member opens a company-wide document's file and
// gets a 404, like for a file that does not exist, for the file of a
// document meant for another department.
test("uploads-follow-their-content", async ({ page }) => {
  const fixtures = loadFixtures();
  await signIn(page, fixtures.users.member);

  await test.step("A company-wide document's file opens, revalidated on every use", async () => {
    const res = await page.request.get(`/uploads/${fixtures.files.companyWide}`);
    expect(res.status()).toBe(200);
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(res.headers()["cache-control"]).toBe("private, no-cache");
  });

  await test.step("Another department's document file is a 404 for the member", async () => {
    const res = await page.request.get(`/uploads/${fixtures.files.otherDepartment}`);
    expect(res.status()).toBe(404);
  });
});
