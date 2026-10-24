import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizCheckResponse, QuizSelection, TrainingCompletionMode } from "@sinnlos/domain";
import type { ActionResult } from "@/lib/action-result";
import type { TrainingActionError } from "@/lib/training-actions";

/** As in notification-bell.test: replay hooks in Node and drive the real component's handlers. */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let pending = 0;
  let transitions: Promise<unknown>[] = [];
  let cleanups: Array<() => void> = [];
  function useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = initial;
    return [
      slots[slot] as T,
      (next) => {
        slots[slot] =
          typeof next === "function" ? (next as (prev: T) => T)(slots[slot] as T) : next;
      },
    ];
  }
  return {
    reset() {
      slots = [];
      cleanups = [];
      transitions = [];
      pending = 0;
    },
    begin() {
      cursor = 0;
    },
    async settle() {
      await Promise.all(transitions);
      transitions = [];
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup());
      cleanups = [];
      slots = [];
    },
    useEffect(effect: () => () => void) {
      const slot = cursor++;
      if (!(slot in slots)) {
        slots[slot] = true;
        cleanups.push(effect());
      }
    },
    useState,
    useRef<T>(initial: T) {
      return useState({ current: initial })[0];
    },
    useTransition(): [boolean, (fn: () => Promise<void>) => void] {
      return [
        pending > 0,
        (fn) => {
          pending++;
          transitions.push(fn().finally(() => pending--));
        },
      ];
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: harness.useState,
  useEffect: harness.useEffect,
  useRef: harness.useRef,
  useTransition: harness.useTransition,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const refresh = vi.fn();
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh }),
}));

type CheckResult = ActionResult<TrainingActionError, QuizCheckResponse["data"]>;
const check = vi.fn<(id: string, answers: QuizSelection[]) => Promise<CheckResult>>();
vi.mock("@/lib/training-actions", () => ({
  checkLesson: (id: string, answers: QuizSelection[]) => check(id, answers),
}));
const { QuizBlock } = await import("./quiz-block");
const gate = vi.fn();
const quiz = [
  { question: "First?", options: ["A", "B"] },
  { question: "Second?", options: ["C", "D"] },
];
const id = "a".repeat(24);

type Props = Record<string, unknown> & { children?: ReactNode };
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
  } else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}

function render(completionMode: TrainingCompletionMode = "confirm", review = false) {
  harness.begin();
  const tree = QuizBlock({
    quiz,
    lessonDocumentId: id,
    completionMode,
    onPassedChange: review ? undefined : gate,
  });
  const all = [...elements(tree)];
  // Native radios (S6): the input carries the choice, its label the verdict colours.
  const options = all.filter((node) => node.type === "input" && node.props.type === "radio");
  const labels = all.filter((node) => node.type === "label");
  const button = all.find((node) => node.type === "button");
  return {
    pick(qi: number, oi: number) {
      (options[qi * 2 + oi]!.props.onChange as () => void)();
    },
    check() {
      expect(button).toBeDefined();
      expect(button!.props.disabled).toBe(false);
      (button!.props.onClick as () => void)();
    },
    checkDisabled: button?.props.disabled,
    text: all
      .map((node) => (typeof node.props.children === "string" ? node.props.children : ""))
      .join(" "),
    colors: labels.map((node) => String(node.props.className)),
    hasFeedback: labels.some((node) => /border-(emerald|red)/.test(String(node.props.className))),
    radioNames: options.map((node) => node.props.name),
    legends: all.filter((node) => node.type === "legend").map((node) => node.props.children),
  };
}

const result = (
  completionMode: TrainingCompletionMode,
  passed: boolean,
  verdicts?: QuizCheckResponse["data"]["verdicts"],
): CheckResult => ({
  ok: true,
  data: { completionMode, passed, ...(verdicts ? { verdicts } : {}) },
});
function deferred() {
  let resolve!: (value: CheckResult) => void;
  const promise = new Promise<CheckResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  harness.reset();
  check.mockReset();
  gate.mockReset();
  refresh.mockReset();
});

describe("quiz semantics (S6)", () => {
  it("renders each question as a fieldset of native radios, one name per question", () => {
    const view = render("quizGate");
    expect(view.legends).toEqual(["First?", "Second?"]);
    expect(view.radioNames).toEqual([
      `quiz-${id}-0`,
      `quiz-${id}-0`,
      `quiz-${id}-1`,
      `quiz-${id}-1`,
    ]);
  });
});

describe("answerless quiz feedback", () => {
  it("asks the server after each confirm selection and unlocks only after its complete passing response", async () => {
    check.mockResolvedValueOnce(result("confirm", false, [{ questionIndex: 0, correct: true }]));
    render().pick(0, 1);
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render().hasFeedback).toBe(false);
    await harness.settle();
    expect(render().colors[1]).toContain("border-emerald");
    check.mockResolvedValueOnce(
      result("confirm", true, [
        { questionIndex: 0, correct: true },
        { questionIndex: 1, correct: true },
      ]),
    );
    render().pick(1, 0);
    expect(gate).toHaveBeenLastCalledWith(null);
    await harness.settle();
    expect(check.mock.calls.map((call) => call[1])).toEqual([
      [{ questionIndex: 0, optionIndex: 1 }],
      [
        { questionIndex: 0, optionIndex: 1 },
        { questionIndex: 1, optionIndex: 0 },
      ],
    ]);
    expect(gate).toHaveBeenLastCalledWith([1, 0]);
  });

  it("collects quizGate answers before checking and invalidates feedback and passing answers on every edit", async () => {
    render("quizGate").pick(0, 0);
    expect(render("quizGate").checkDisabled).toBe(true);
    render("quizGate").pick(1, 1);
    expect(check).not.toHaveBeenCalled();
    check.mockResolvedValue(
      result("quizGate", true, [
        { questionIndex: 0, correct: true },
        { questionIndex: 1, correct: true },
      ]),
    );
    render("quizGate").check();
    await harness.settle();
    expect(gate).toHaveBeenLastCalledWith([0, 1]);
    render("quizGate").pick(0, 1);
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render("quizGate").hasFeedback).toBe(false);
    expect(render("quizGate").text).not.toContain("quizAllCorrect");
  });

  it.each([false, true])(
    "keeps exam feedback aggregate-only, also during completed review=%s",
    async (review) => {
      render("exam", review).pick(0, 0);
      render("exam", review).pick(1, 1);
      check.mockResolvedValue(result("exam", false));
      render("exam", review).check();
      await harness.settle();
      const view = render("exam", review);
      expect(view.hasFeedback).toBe(false);
      expect(view.text).toContain("quizExamNotPassed");
      expect(view.text).not.toContain("quizSomeWrong");
      expect(view.text).not.toContain("quizInstantHint");
      if (review) expect(gate).not.toHaveBeenCalled();
      else expect(gate).toHaveBeenLastCalledWith(null);
    },
  );

  it("uses the response's mode after a quizGate course switches to exam", async () => {
    render("quizGate").pick(0, 0);
    render("quizGate").pick(1, 1);
    check.mockResolvedValue(result("exam", false, [{ questionIndex: 0, correct: false }]));
    render("quizGate").check();
    await harness.settle();
    expect(render("quizGate").text).toContain("quizExamHint");
    expect(render("quizGate").hasFeedback).toBe(false);
  });

  it("ignores older passing feedback that arrives after newer failing feedback", async () => {
    const old = deferred();
    const current = deferred();
    check
      .mockResolvedValueOnce(result("confirm", false))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    render().pick(0, 0);
    await harness.settle();
    render().pick(1, 1);
    render().pick(0, 1);
    current.resolve(result("confirm", false, [{ questionIndex: 0, correct: false }]));
    await Promise.resolve();
    await Promise.resolve();
    old.resolve(result("confirm", true));
    await harness.settle();
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render().text).not.toContain("quizAllCorrect");
    expect(render().colors[1]).toContain("border-red");
  });

  it("ignores late feedback after completion refusal remounts an empty quiz", async () => {
    const pending = deferred();
    check.mockResolvedValueOnce(result("confirm", false)).mockReturnValueOnce(pending.promise);
    render().pick(0, 0);
    await harness.settle();
    render().pick(1, 1);
    harness.unmount();
    expect(render().hasFeedback).toBe(false);
    pending.resolve(result("confirm", true));
    await harness.settle();
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render().text).not.toContain("quizAllCorrect");
  });

  it("does not unlock changed answers while a batch check is pending", async () => {
    const pending = deferred();
    render("quizGate").pick(0, 0);
    render("quizGate").pick(1, 1);
    check.mockReturnValue(pending.promise);
    render("quizGate").check();
    expect(render("quizGate").checkDisabled).toBe(true);
    render("quizGate").pick(0, 1);
    pending.resolve(result("quizGate", true));
    await harness.settle();
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render("quizGate").text).not.toContain("quizAllCorrect");
  });

  it("refreshes a refused partial check to learn a changed server mode without unlocking", async () => {
    check.mockResolvedValue({ ok: false, code: "quizFailed" });
    render().pick(0, 0);
    await harness.settle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render().text).toContain("quizNotPassed");
  });

  it("offers a retry of the same answers after a failed confirm check (S6: native radios)", async () => {
    check.mockResolvedValueOnce({ ok: false, code: "unavailable" });
    render().pick(0, 1);
    await harness.settle();
    check.mockResolvedValueOnce(result("confirm", false, [{ questionIndex: 0, correct: true }]));
    render().check();
    await harness.settle();
    expect(check.mock.calls.map((call) => call[1])).toEqual([
      [{ questionIndex: 0, optionIndex: 1 }],
      [{ questionIndex: 0, optionIndex: 1 }],
    ]);
    expect(render().colors[1]).toContain("border-emerald");
  });

  it.each(["quizContentInvalid", "unavailable"] as const)(
    "keeps %s failures out of the completion gate",
    async (code) => {
      check.mockResolvedValue({ ok: false, code });
      render().pick(0, 0);
      await harness.settle();
      expect(gate).toHaveBeenLastCalledWith(null);
      expect(render().text).toContain(code);
    },
  );

  it("cannot unlock a locally incomplete selection from a mismatched passing response", async () => {
    check.mockResolvedValue(result("confirm", true));
    render().pick(0, 0);
    await harness.settle();
    expect(gate).toHaveBeenLastCalledWith(null);
    expect(render().text).not.toContain("quizAllCorrect");
  });
});
