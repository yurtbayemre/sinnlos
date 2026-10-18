import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

export type Account = { email: string; password: string };
export type Team = { name: string; slug: string; description: string };
export type TrainingFixture = {
  course: { title: string; slug: string; documentId: string };
  lesson: { title: string; documentId: string };
};
type Fixtures = {
  runId: string;
  users: { lead: Account; member: Account };
  teams: { editable: Team; readonly: Team };
  training: TrainingFixture;
  exam: TrainingFixture;
  confirm: TrainingFixture;
};

export function loadFixtures(): Fixtures {
  const fixturePath = process.env.SINNLOS_E2E_FIXTURES;
  if (!fixturePath)
    throw new Error("Run this test through pnpm test:e2e to create fresh fixtures.");
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

export async function signIn(page: Page, account: Account) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("banner").getByText(account.email, { exact: true })).toBeVisible();
}
