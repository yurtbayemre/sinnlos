import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import type { CompletionMode } from "@/lib/training-shared";

/** Initial rendering in every mode, including no-quiz lessons and completed exam review. */
vi.mock("@/lib/training-actions", () => ({ completeLesson: vi.fn(), checkLesson: vi.fn() }));
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

const QUIZ = [{ question: "Which port does HTTPS use?", options: ["21", "80", "443"] }];

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
      version: { course: "2026-10-01T08:00:00.000Z", lesson: "2026-10-02T09:30:00.000Z" },
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
  it.each(["confirm", "quizGate", "exam"] as const)(
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
    expect(lesson("exam")).toContain(en.training.quizExamHint);
    expect(lesson("exam")).toContain(en.training.quizCheckButton);
  });

  it("never locks a lesson without questions", () => {
    for (const mode of ["confirm", "quizGate", "exam"] as const) {
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
    const exam = lesson("exam", QUIZ, "1 October 2026");
    expect(exam).toContain(en.training.quizExamHint);
    expect(exam).not.toContain(en.training.quizInstantHint);
  });
});
