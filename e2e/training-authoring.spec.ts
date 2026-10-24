import { expect, test, type Page } from "@playwright/test";
import { loadFixtures, signIn } from "./helpers";

async function publish(page: Page) {
  await page.getByRole("main").getByRole("button", { name: "Publish", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Publish now?", exact: true })
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await expect(page.getByRole("status").filter({ hasText: /^Published\.$/ })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("button", { name: "Unpublish", exact: true }),
  ).toBeVisible();
}

test("training-authoring", async ({ page, browser }) => {
  const fixtures = loadFixtures();
  const courseTitle = "E2E Authored Course";
  const lessonTitle = "E2E Authored Lesson";
  const description = "A course created through the browser.";
  const content = "HTTPS protects the connection to a website.";
  const questionText = "Which port is used for HTTPS?";
  const main = page.getByRole("main");
  const save = main.getByRole("button", { name: "Save draft", exact: true });
  const question = main.getByRole("group", { name: "Question 1", exact: true });
  const answer1 = question.getByRole("radio", { name: "Mark answer 1 as correct", exact: true });
  const answer2 = question.getByRole("radio", { name: "Mark answer 2 as correct", exact: true });

  await test.step("Editor creates and reloads a course draft through Manage", async () => {
    await signIn(page, fixtures.users.editor);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Manage", exact: true })
      .click();
    await expect(page).toHaveURL("/manage");
    await main.getByRole("link", { name: "Training", exact: true }).click();
    await main.getByRole("link", { name: "New course", exact: true }).click();
    await expect(page).toHaveURL("/manage/training/new");
    await main.getByRole("textbox", { name: "Title", exact: true }).fill(courseTitle);
    await main.getByRole("textbox", { name: "Description", exact: true }).fill(description);
    await main.getByRole("button", { name: /^Quiz feedback / }).click();
    await page
      .getByRole("menuitemradio", { name: "Check all answers together", exact: true })
      .click();
    await expect(
      main.getByRole("checkbox", { name: "Mandatory course", exact: true }),
    ).not.toBeChecked();
    await save.click();
    await expect(page).toHaveURL(/\/manage\/training\/(?!new$)[^/]+$/);
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved as a draft\.$/ }),
    ).toBeVisible();
    await page.reload();
    await expect(main.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(
      courseTitle,
    );
    await expect(main.getByRole("textbox", { name: "Description", exact: true })).toHaveValue(
      description,
    );
    await expect(
      main.getByRole("button", { name: "Quiz feedback Check all answers together", exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(main.getByText("Draft", { exact: true })).toBeVisible();
  });

  await test.step("Editor publishes the course and creates a lesson with a quiz", async () => {
    await publish(page);
    await main.getByRole("link", { name: "Lessons", exact: true }).click();
    await main.getByRole("link", { name: "New lesson", exact: true }).click();
    await expect(main.getByRole("textbox", { name: "Course", exact: true })).toHaveValue(
      courseTitle,
    );
    await main.getByRole("textbox", { name: "Title", exact: true }).fill(lessonTitle);
    await main.getByRole("textbox", { name: "Lesson content", exact: true }).fill(content);
    await main.getByRole("button", { name: "Add question", exact: true }).click();
    await question
      .getByRole("textbox", { name: "Question text", exact: true })
      .fill("Which port is used for HTTP?");
    await question.getByRole("textbox", { name: "Answer 1", exact: true }).fill("80");
    await question.getByRole("textbox", { name: "Answer 2", exact: true }).fill("443");
    await answer1.check();
    await save.click();
    await expect(page).toHaveURL(/\/manage\/training\/[^/]+\/lessons\/(?!new$)[^/]+$/);
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved as a draft\.$/ }),
    ).toBeVisible();
    await page.reload();
    await expect(question.getByRole("textbox", { name: "Question text", exact: true })).toHaveValue(
      "Which port is used for HTTP?",
    );
    await expect(answer1).toBeChecked();
    await expect(save).toBeDisabled();
  });

  await test.step("A quiz-only edit enables saving and survives a full reload", async () => {
    await question.getByRole("textbox", { name: "Question text", exact: true }).fill(questionText);
    await answer2.check();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: /^Draft saved\.$/ })).toBeVisible();
    await expect(save).toBeDisabled();
    await page.reload();
    await expect(question.getByRole("textbox", { name: "Question text", exact: true })).toHaveValue(
      questionText,
    );
    await expect(question.getByRole("textbox", { name: "Answer 1", exact: true })).toHaveValue(
      "80",
    );
    await expect(question.getByRole("textbox", { name: "Answer 2", exact: true })).toHaveValue(
      "443",
    );
    await expect(answer2).toBeChecked();
    await expect(answer1).not.toBeChecked();
    await expect(main.getByRole("textbox", { name: "Lesson content", exact: true })).toHaveValue(
      content,
    );
    await expect(save).toBeDisabled();
    await expect(main.getByRole("alert")).toHaveCount(0);
  });

  await test.step("Editor publishes the saved lesson", async () => {
    await publish(page);
    await page.reload();
    await expect(main.getByRole("button", { name: "Unpublish", exact: true })).toBeVisible();
    await expect(answer2).toBeChecked();
    await expect(main.getByRole("alert")).toHaveCount(0);
  });

  await test.step("A separate member session reads the published lesson and uses the changed answer", async () => {
    const memberContext = await browser.newContext();
    try {
      const memberPage = await memberContext.newPage();
      await signIn(memberPage, fixtures.users.member);
      const memberMain = memberPage.getByRole("main");
      await memberPage
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Training", exact: true })
        .click();
      await memberMain
        .getByRole("link")
        .filter({
          has: memberPage.getByRole("heading", { name: courseTitle, level: 2, exact: true }),
        })
        .click();
      await expect(
        memberMain.getByRole("heading", { name: courseTitle, level: 1, exact: true }),
      ).toBeVisible();
      await expect(memberMain.getByText(description, { exact: true })).toBeVisible();
      await memberMain.getByRole("link", { name: "Start course", exact: true }).click();
      await expect(
        memberMain.getByRole("heading", { name: lessonTitle, level: 1, exact: true }),
      ).toBeVisible();
      await expect(memberMain.getByText(content, { exact: true })).toBeVisible();
      const publishedQuestion = memberMain.getByRole("group", { name: questionText, exact: true });
      const complete = memberMain.getByRole("button", { name: "Complete lesson", exact: true });
      await publishedQuestion.getByRole("radio", { name: "80", exact: true }).click();
      await memberMain.getByRole("button", { name: "Check answers", exact: true }).click();
      await expect(memberMain.getByText("Not quite — try again.", { exact: true })).toBeVisible();
      await expect(complete).toBeDisabled();
      await publishedQuestion.getByRole("radio", { name: "443", exact: true }).click();
      await memberMain.getByRole("button", { name: "Check answers", exact: true }).click();
      await expect(memberMain.getByText("All correct!", { exact: true })).toBeVisible();
      await expect(complete).toBeEnabled();
      await expect(memberMain.getByRole("alert")).toHaveCount(0);
    } finally {
      await memberContext.close();
    }
  });
});
