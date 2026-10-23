import { createHmac } from "node:crypto";
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
  users: {
    lead: Account;
    member: Account;
    editor: Account;
    admin: Account;
    inviter: Account;
    privacy: Account;
    leaver: Account & { id: number };
  };
  privacy: { announcement: { title: string; documentId: string }; comment: string };
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

/** RFC 4648 base32 → bytes (the authenticator secret of /mfa/setup). */
function base32Bytes(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/[\s=]/g, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("not base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The RFC 6238 code (SHA-1, 6 digits, 30 s) of `secret` for time step `step`. */
export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Bytes(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, "0");
}

export const currentStep = () => Math.floor(Date.now() / 30_000);

/** A code of a time step after `usedStep` (the cms accepts each step once). */
export async function codeAfter(
  secret: string,
  usedStep: number,
): Promise<{ code: string; step: number }> {
  while (currentStep() <= usedStep) await new Promise((done) => setTimeout(done, 1_000));
  const step = currentStep();
  return { code: totp(secret, step), step };
}

/**
 * Signs in an account whose role needs a second factor and has none yet:
 * the app sends it to /mfa/setup, where it enrolls with the shown secret.
 * Resolves the secret, the step its code used and the recovery codes.
 */
export async function signInAndEnroll(page: Page, account: Account) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/mfa/setup");
  const secret = (await page.locator("code").first().innerText()).trim();
  const step = currentStep();
  await page.getByLabel("Code", { exact: true }).fill(totp(secret, step));
  await page.getByLabel("Current password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your recovery codes" })).toBeVisible();
  const recoveryCodes = await page.getByRole("listitem").allInnerTexts();
  await page.getByRole("button", { name: "I have saved the codes", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("banner").getByText(account.email, { exact: true })).toBeVisible();
  return { secret, step, recoveryCodes };
}
