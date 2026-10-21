import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateQuiz, type QuizQuestion } from "@sinnlos/domain";

/**
 * The quiz builder's checking (v0.20.1, Emre's report): "Check quiz" shows a
 * visible result, only the fields that are actually wrong are marked, and a
 * question or answer added after a check stays unmarked until the next one.
 * The hooks run on a slot harness, as in training-editor-state.test.ts.
 */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [
      slots[i] as T,
      (next) => {
        slots[i] = typeof next === "function" ? (next as (previous: T) => T)(slots[i] as T) : next;
      },
    ];
  }
  return {
    reset() {
      slots = [];
    },
    begin() {
      cursor = 0;
    },
    useState,
    useRef<T>(value: T) {
      return useState({ current: value })[0];
    },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: harness.useState,
  useRef: harness.useRef,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.stubGlobal("requestAnimationFrame", () => 0);

const { QuizBuilder, questionProblems } = await import("./quiz-builder");
const { tagById } = await import("./render.test.helper");

type Props = Record<string, unknown> & { children?: ReactNode };
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) for (const child of node) yield* elements(child);
  else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}

const filled: QuizQuestion = {
  question: "Wie groß bist du?",
  options: ["191", "190", "189"],
  correctIndex: 0,
};
const onChange = vi.fn();
const props = (value: QuizQuestion[]) => ({ id: "q", value, onChange });
const html = (value: QuizQuestion[]) => {
  harness.begin();
  return renderToStaticMarkup(createElement(QuizBuilder, props(value)));
};
const click = (value: QuizQuestion[], label: string) => {
  harness.begin();
  const button = [...elements(QuizBuilder(props(value)))].find(
    (node) => node.props.children === label && typeof node.props.onClick === "function",
  );
  (button!.props.onClick as () => void)();
};

beforeEach(() => {
  harness.reset();
  onChange.mockReset();
});

describe("quiz builder checking", () => {
  it("shows a valid quiz as valid after Check quiz, and marks nothing", () => {
    expect(html([filled])).not.toContain(">valid</p>");
    click([filled], "validate");
    const page = html([filled]);
    expect(page).toContain(">valid</p>");
    expect(page).not.toContain('aria-invalid="true"');
  });

  it("keeps a filled question unmarked when a question is added after a check", () => {
    click([filled], "validate");
    click([filled], "addQuestion");
    const added = onChange.mock.calls[0][0] as QuizQuestion[];
    expect(added).toHaveLength(2);
    const page = html(added);
    // The new, empty question waits for the next check; the first stays as it was.
    expect(page).not.toContain('aria-invalid="true"');
    expect(page).not.toContain(">invalid<");
  });

  it("marks only the wrong fields of the next check", () => {
    const added = [filled, { question: "", options: ["", "B"], correctIndex: -1 }];
    click(added, "validate");
    const page = html(added);
    expect(page).toContain(">invalid<");
    expect(tagById(page, "q")).not.toContain('aria-invalid="true"');
    expect(tagById(page, "q-option-0-0")).not.toContain('aria-invalid="true"');
    expect(tagById(page, "q-question-1")).toContain('aria-invalid="true"');
    expect(tagById(page, "q-option-1-0")).toContain('aria-invalid="true"');
    expect(tagById(page, "q-option-1-1")).not.toContain('aria-invalid="true"');
    expect(page).toContain(">chooseCorrectMissing<");
  });

  it("an answer added after a check stays unmarked too", () => {
    click([filled], "validate");
    click([filled], "addOption");
    const page = html(onChange.mock.calls[0][0] as QuizQuestion[]);
    expect(page).not.toContain('aria-invalid="true"');
  });
});

describe("quiz builder and the cms's refusal", () => {
  const broken = { question: "Q", options: [" ", "B"], correctIndex: 1 };
  const withError = (value: QuizQuestion[], error?: string) => {
    harness.begin();
    return renderToStaticMarkup(createElement(QuizBuilder, { ...props(value), error }));
  };

  it("marks the refused answer, describes the error on it and on the focus target", () => {
    const page = withError([filled, broken], "Invalid quiz");
    expect(tagById(page, "q-option-1-0")).toContain('aria-invalid="true"');
    expect(tagById(page, "q-option-1-0")).toContain('aria-describedby="q-error"');
    expect(tagById(page, "q")).not.toContain('aria-invalid="true"');
    expect(tagById(page, "q")).toContain('aria-describedby="q-hint q-error"');
  });

  it("leaves fields added after a refused save unmarked until the next check", () => {
    withError([broken], "Invalid quiz");
    harness.begin();
    const button = [...elements(QuizBuilder({ ...props([broken]), error: "Invalid quiz" }))].find(
      (node) => node.props.children === "addQuestion",
    );
    (button!.props.onClick as () => void)();
    const page = withError(onChange.mock.calls[0][0] as QuizQuestion[], "Invalid quiz");
    expect(tagById(page, "q-question-1")).not.toContain('aria-invalid="true"');
    expect(page).toContain(">Invalid quiz<");
  });

  it("retires a refusal once the quiz is valid again: no contradictory messages", () => {
    const page = withError([filled], "Invalid quiz");
    expect(page).not.toContain(">Invalid quiz<");
    expect(page).not.toContain('aria-invalid="true"');
    click([filled], "validate");
    const checkedPage = withError([filled], "Invalid quiz");
    expect(checkedPage).toContain(">valid</p>");
    expect(checkedPage).not.toContain(">Invalid quiz<");
  });

  it("names the answer limit for a question loaded with too many answers", () => {
    const crowded = {
      question: "Q",
      options: Array.from({ length: 9 }, (_, i) => `A${i}`),
      correctIndex: 0,
    };
    click([crowded], "validate");
    expect(html([crowded])).toContain(">answerCount<");
  });
});

describe("questionProblems", () => {
  it.each<[string, QuizQuestion]>([
    ["valid", filled],
    ["empty question", { ...filled, question: "  " }],
    ["empty answer", { ...filled, options: ["191", " ", "189"] }],
    ["no correct answer", { ...filled, correctIndex: -1 }],
    ["correct answer out of range", { ...filled, correctIndex: 3 }],
    ["too long", { ...filled, question: "x".repeat(501) }],
    ["one answer", { ...filled, options: ["191"], correctIndex: 0 }],
    ["nine answers", { ...filled, options: Array.from({ length: 9 }, (_, i) => `A${i}`) }],
  ])("agrees with the shared validator: %s", (_name, question) => {
    const p = questionProblems(question);
    const flagged = p.question || p.count || p.correct || p.options.some(Boolean);
    expect(flagged).toBe("error" in validateQuiz([question]));
  });
});
