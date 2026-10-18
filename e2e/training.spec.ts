import { expect, test } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

test("training-quiz-completion", async ({ page }) => {
  const fixtures = loadFixtures();
  const { course, lesson } = fixtures.training;
  const main = page.getByRole("main");
  const https = main.getByRole("group", { name: "Which port is used for HTTPS?", exact: true });
  const phishing = main.getByRole("group", {
    name: "Should you report a phishing email?",
    exact: true,
  });
  const check = main.getByRole("button", { name: "Check answers", exact: true });
  const complete = main.getByRole("button", { name: "Complete lesson", exact: true });
  const courseCard = main.getByRole("link").filter({
    has: page.getByRole("heading", { name: course.title, level: 2, exact: true }),
  });

  await test.step("Member opens the unfinished course through Training", async () => {
    await signIn(page, fixtures.users.member);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Training", exact: true })
      .click();
    await expect(page).toHaveURL("/training");
    await expect(courseCard.getByText("0 of 1 done", { exact: true })).toBeVisible();
    await courseCard.click();
    await expect(page).toHaveURL(`/training/${course.slug}`);
    await expect(main.getByRole("heading", { name: course.title, level: 1 })).toBeVisible();
    await expect(main.getByText("0 of 1 done", { exact: true })).toBeVisible();
    await main.getByRole("link", { name: "Start course", exact: true }).click();
    await expect(page).toHaveURL(`/training/${course.slug}/${lesson.documentId}`);
    await expect(main.getByRole("heading", { name: lesson.title, level: 1 })).toBeVisible();
  });

  await test.step("Missing and wrong answers keep completion locked", async () => {
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await https.getByRole("button", { name: "80", exact: true }).click();
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await phishing.getByRole("button", { name: "Yes", exact: true }).click();
    await check.click();
    await expect(
      main.getByRole("status").filter({
        hasText: "1 answer is not right yet — adjust and check again.",
      }),
    ).toBeVisible();
    await expect(main.getByText("Not quite — try again.", { exact: true })).toBeVisible();
    await expect(complete).toBeDisabled();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(complete).toBeDisabled();
    await expect(main.getByText(/^Completed on /)).toHaveCount(0);
  });

  await test.step("Passing the quiz alone does not persist a completion", async () => {
    await https.getByRole("button", { name: "443", exact: true }).click();
    await phishing.getByRole("button", { name: "Yes", exact: true }).click();
    await check.click();
    await expect(main.getByText("All correct!", { exact: true })).toBeVisible();
    await expect(complete).toBeEnabled();
    await page.reload();
    await expect(complete).toBeDisabled();
    await expect(check).toBeDisabled();
    await expect(main.getByText(/^Completed on /)).toHaveCount(0);
  });

  await test.step("Explicit completion survives a full reload", async () => {
    await https.getByRole("button", { name: "443", exact: true }).click();
    await phishing.getByRole("button", { name: "Yes", exact: true }).click();
    await check.click();
    await expect(main.getByText("All correct!", { exact: true })).toBeVisible();
    await complete.click();
    await expect(main.getByText(/^Completed(?: on .+)?$/)).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(main.getByText(/^Completed on .+/)).toBeVisible();
    await expect(complete).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
  });

  await test.step("Course details and overview show the stored completion", async () => {
    await main.getByRole("link", { name: course.title, exact: true }).click();
    await expect(page).toHaveURL(`/training/${course.slug}`);
    await expect(main.getByText("Completed", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Start course", exact: true })).toHaveCount(0);
    await main.getByRole("link", { name: "Training", exact: true }).click();
    await expect(page).toHaveURL("/training");
    await expect(courseCard.getByText("Completed", { exact: true })).toBeVisible();
    await expect(main.getByRole("alert")).toHaveCount(0);
  });
});
