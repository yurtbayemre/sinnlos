import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { parseQuiz, type CompletionMode } from "@/lib/training-shared";

/**
 * Server-rendered markup of the lesson's quiz and completion button (issue
 * #70): an open lesson with questions starts with the button locked on
 * EVERY course, the default "confirm" one included (which offered it
 * unlocked next to a wrong answer); the course's mode picks the feedback
 * only. A lesson without questions and a completed lesson are never
 * locked. The pick-by-pick behaviour is QuizBlock's, on the shared helpers
 * (lib/training-shared.test.ts); the cms checks the answers itself
 * (lesson-progress create).
 *
 * The server action module and the router are stubbed; next-intl renders
 * the real English catalog.
 */
vi.mock("@/lib/training-actions", () => ({ completeLesson: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { LessonCompletion } = await import("./lesson-completion");

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Berlin",
      children: element,
    }),
  );

const QUIZ = parseQuiz([
  { question: "Which port does HTTPS use?", options: ["21", "80", "443"], correctIndex: 2 },
]);

const lesson = (
  completionMode: CompletionMode,
  quiz = QUIZ,
  completedAtLabel: string | null = null,
) =>
  render(
    createElement(LessonCompletion, {
      quiz,
      completionMode,
      lessonDocumentId: "k3m9x0000000000000000000",
      completedAtLabel,
      nextHref: null,
    }),
  );

/** The completion button's opening tag (the quiz's option buttons say type="button"). */
const completeButton = (html: string) =>
  (html.match(/<button[^>]*>/g) ?? []).find((tag) => !tag.includes('type="button"')) ?? "";

/** The boolean `disabled` attribute (not the `disabled:` Tailwind variant in the class). */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("LessonCompletion", () => {
  it.each(["confirm", "quizGate"] as const)(
    "locks the completion of an open quiz lesson on a %s course",
    (mode) => {
      const html = lesson(mode);
      expect(html).toContain(en.training.completeButton);
      expect(isDisabled(completeButton(html))).toBe(true);
      expect(html).toContain(en.training.completeLocked);
      expect(html).toContain(en.training.quizGateTitle);
    },
  );

  it("keeps the feedback of the course's mode: per answer on confirm, one check on quizGate", () => {
    expect(lesson("confirm")).toContain(en.training.quizInstantHint);
    expect(lesson("confirm")).not.toContain(en.training.quizCheckButton);
    expect(lesson("quizGate")).toContain(en.training.quizCheckButton);
  });

  it("never locks a lesson without questions", () => {
    for (const mode of ["confirm", "quizGate"] as const) {
      const html = lesson(mode, []);
      expect(isDisabled(completeButton(html))).toBe(false);
      expect(html).not.toContain(en.training.completeLocked);
    }
  });

  it("shows a completed lesson's quiz for review, unlocked", () => {
    const html = lesson("quizGate", QUIZ, "1 October 2026");
    expect(html).toContain(en.training.quizTitle);
    expect(html).not.toContain(en.training.completeLocked);
    expect(html).not.toContain(en.training.completeButton);
  });
});
