import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn, type TrainingFixture } from "./helpers";

async function openLesson(page: Page, { course, lesson }: TrainingFixture) {
  const main = page.getByRole("main");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Training", exact: true })
    .click();
  await expect(page).toHaveURL("/training");
  const courseCard = main.getByRole("link").filter({
    has: page.getByRole("heading", { name: course.title, level: 2, exact: true }),
  });
  await expect(courseCard.getByText("0 of 1 done", { exact: true })).toBeVisible();
  await courseCard.click();
  await expect(page).toHaveURL(`/training/${course.slug}`);
  await expect(main.getByRole("heading", { name: course.title, level: 1 })).toBeVisible();
  await expect(main.getByText("0 of 1 done", { exact: true })).toBeVisible();
  await main.getByRole("link", { name: "Start course", exact: true }).click();
  await expect(page).toHaveURL(`/training/${course.slug}/${lesson.documentId}`);
  await expect(main.getByRole("heading", { name: lesson.title, level: 1 })).toBeVisible();
}

test("training-quiz-completion", async ({ page }) => {
  const fixtures = loadFixtures();
  const { course } = fixtures.training;
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
    await openLesson(page, fixtures.training);
  });

  await test.step("Missing and wrong answers keep completion locked", async () => {
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await https.getByRole("radio", { name: "80", exact: true }).click();
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
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
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await check.click();
    await expect(main.getByText("All correct!", { exact: true })).toBeVisible();
    await expect(complete).toBeEnabled();
    await page.reload();
    await expect(complete).toBeDisabled();
    await expect(check).toBeDisabled();
    await expect(main.getByText(/^Completed on /)).toHaveCount(0);
  });

  await test.step("Explicit completion survives a full reload", async () => {
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await check.click();
    await expect(main.getByText("All correct!", { exact: true })).toBeVisible();
    await complete.click();
    // S6: without a reload, the refreshed completion takes the focus the button had.
    await expect(main.getByText(/^Completed on .+/)).toBeFocused();
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

test("training-exam-completion", async ({ page }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const https = main.getByRole("group", { name: "Which port is used for HTTPS?", exact: true });
  const phishing = main.getByRole("group", {
    name: "Should you report a phishing email?",
    exact: true,
  });
  const check = main.getByRole("button", { name: "Check answers", exact: true });
  const complete = main.getByRole("button", { name: "Complete lesson", exact: true });
  const completed = main.getByText(/^Completed on .+/);
  const examHint = main.getByText(
    "This exam shows only whether all answers passed. You can retry as often as you like.",
    { exact: true },
  );
  const notPassed = "Not passed yet. Review your answers and try again.";

  async function expectOverallFeedback(message: string) {
    await expect(main.getByRole("status")).toHaveText([message]);
    await expect(main.getByText("Correct!", { exact: true })).toHaveCount(0);
    await expect(main.getByText("Not quite — try again.", { exact: true })).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
  }

  await test.step("Member opens an unfinished exam through Training", async () => {
    await signIn(page, fixtures.users.member);
    await openLesson(page, fixtures.exam);
    await expect(examHint).toBeVisible();
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
  });

  await test.step("Missing or wrong answers cannot complete the exam", async () => {
    await https.getByRole("radio", { name: "80", exact: true }).click();
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await check.click();
    await expectOverallFeedback(notPassed);
    await expect(complete).toBeDisabled();
    await expect(completed).toHaveCount(0);
  });

  await test.step("Passing shows only an overall result and creates no receipt", async () => {
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await expect(complete).toBeDisabled();
    await check.click();
    await expectOverallFeedback("All correct!");
    await expect(complete).toBeEnabled();
    await page.reload();
    await expect(check).toBeDisabled();
    await expect(complete).toBeDisabled();
    await expect(completed).toHaveCount(0);
  });

  await test.step("Explicit completion survives a full reload", async () => {
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await check.click();
    await expectOverallFeedback("All correct!");
    await complete.click();
    await expect(main.getByText(/^Completed(?: on .+)?$/)).toBeVisible();
    await page.reload();
    await expect(completed).toBeVisible();
    await expect(complete).toHaveCount(0);
    await expect(
      main.getByRole("heading", { name: "Self-check questions", exact: true }),
    ).toBeVisible();
    await expect(examHint).toBeVisible();
  });

  await test.step("Completed exam review stays overall-only and preserves the receipt", async () => {
    await https.getByRole("radio", { name: "80", exact: true }).click();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await check.click();
    await expectOverallFeedback(notPassed);
    await expect(completed).toBeVisible();
    await expect(complete).toHaveCount(0);
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await check.click();
    await expectOverallFeedback("All correct!");
    await expect(completed).toBeVisible();
    await expect(complete).toHaveCount(0);
    await page.reload();
    await expect(completed).toBeVisible();
    await expect(complete).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
  });
});

test("training-confirm-completion", async ({ page }) => {
  const fixtures = loadFixtures();
  const main = page.getByRole("main");
  const https = main.getByRole("group", { name: "Which port is used for HTTPS?", exact: true });
  const phishing = main.getByRole("group", {
    name: "Should you report a phishing email?",
    exact: true,
  });
  const check = main.getByRole("button", { name: "Check answers", exact: true });
  const complete = main.getByRole("button", { name: "Complete lesson", exact: true });
  const completed = main.getByText(/^Completed on .+/);
  const correct = main.getByText("Correct!", { exact: true });
  const wrong = main.getByText("Not quite — try again.", { exact: true });
  const passed = main.getByText("All correct!", { exact: true });

  await test.step("Member opens a confirm lesson without a check button", async () => {
    await signIn(page, fixtures.users.member);
    await openLesson(page, fixtures.confirm);
    await expect(
      main.getByText(
        "Answer every question correctly to complete the lesson — retrying is expressly allowed.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(check).toHaveCount(0);
    await expect(complete).toBeDisabled();
  });

  await test.step("Each selection gets immediate feedback while missing or wrong answers stay locked", async () => {
    await https.getByRole("radio", { name: "80", exact: true }).click();
    await expect(wrong).toBeVisible();
    await expect(correct).toHaveCount(0);
    await expect(complete).toBeDisabled();
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await expect(correct).toHaveCount(1);
    await expect(wrong).toHaveCount(0);
    await expect(passed).toHaveCount(0);
    await expect(complete).toBeDisabled();
    await phishing.getByRole("radio", { name: "No", exact: true }).click();
    await expect(wrong).toBeVisible();
    await expect(correct).toHaveCount(1);
    await expect(complete).toBeDisabled();
    await expect(check).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
  });

  await test.step("Only all correct answers unlock completion and a wrong edit locks it again", async () => {
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await expect(passed).toBeVisible();
    await expect(correct).toHaveCount(2);
    await expect(wrong).toHaveCount(0);
    await expect(complete).toBeEnabled();
    await https.getByRole("radio", { name: "80", exact: true }).click();
    await expect(wrong).toBeVisible();
    await expect(correct).toHaveCount(1);
    await expect(passed).toHaveCount(0);
    await expect(complete).toBeDisabled();
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await expect(passed).toBeVisible();
    await expect(correct).toHaveCount(2);
    await expect(complete).toBeEnabled();
    await expect(check).toHaveCount(0);
    await page.reload();
    await expect(complete).toBeDisabled();
    await expect(completed).toHaveCount(0);
    await expect(correct).toHaveCount(0);
    await expect(passed).toHaveCount(0);
  });

  await test.step("Explicit completion survives a full reload", async () => {
    await https.getByRole("radio", { name: "443", exact: true }).click();
    await expect(correct).toHaveCount(1);
    await expect(complete).toBeDisabled();
    await phishing.getByRole("radio", { name: "Yes", exact: true }).click();
    await expect(passed).toBeVisible();
    await expect(correct).toHaveCount(2);
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(main.getByText(/^Completed(?: on .+)?$/)).toBeVisible();
    await page.reload();
    await expect(completed).toBeVisible();
    await expect(complete).toHaveCount(0);
    await expect(check).toHaveCount(0);
    await expect(main.getByRole("alert")).toHaveCount(0);
  });
});
