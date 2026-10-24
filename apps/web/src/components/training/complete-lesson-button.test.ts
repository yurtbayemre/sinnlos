import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { TrainingActionError } from "@/lib/training-actions";

/**
 * S6: the completion's focus and stale-error rules across the refresh that
 * delivers the authoritative state. As in quiz-block.test, hooks are
 * replayed in Node; effects here also honour their dependencies, and the
 * completed text's ref gets a stand-in element whose focus() is counted.
 */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let transitions: Promise<unknown>[] = [];
  let effects: Array<() => void> = [];
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
      transitions = [];
      effects = [];
    },
    begin() {
      cursor = 0;
      effects = [];
    },
    /** Runs the effects queued by the last render (after "commit"). */
    commit() {
      effects.forEach((effect) => effect());
    },
    async settle() {
      await Promise.all(transitions);
      transitions = [];
    },
    useState,
    useRef<T>(initial: T) {
      return useState({ current: initial })[0];
    },
    useEffect(effect: () => void, deps: unknown[]) {
      const slot = cursor++;
      const previous = slots[slot] as unknown[] | undefined;
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
        slots[slot] = deps;
        effects.push(effect);
      }
    },
    useTransition(): [boolean, (fn: () => Promise<void>) => void] {
      return [false, (fn) => void transitions.push(fn())];
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const complete = vi.fn<() => Promise<ActionResult<TrainingActionError, unknown>>>();
vi.mock("@/lib/training-actions", () => ({ completeLesson: () => complete() }));

const { CompleteLessonButton } = await import("./complete-lesson-button");

type Props = Record<string, unknown> & { children?: ReactNode };
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
  } else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}

const focus = vi.fn();
const version = { course: "2026-10-01T08:00:00.000Z", lesson: "2026-10-02T09:30:00.000Z" };

/** Renders with these props, attaches the stand-in element, runs the effects. */
function render(completedAtLabel: string | null) {
  harness.begin();
  const tree = CompleteLessonButton({
    lessonDocumentId: "k".repeat(24),
    version,
    completedAtLabel,
  });
  const all = [...elements(tree)];
  const done = all.find((node) => node.props.tabIndex === -1);
  if (done) (done.props.ref as { current: unknown }).current = { focus };
  harness.commit();
  // The completed text: its string children (the icon is an element).
  const text = (node: ReactElement<Props>) =>
    ([node.props.children].flat() as unknown[]).filter((c) => typeof c === "string").join("");
  return {
    click: () => (all.find((node) => node.props.onClick)!.props.onClick as () => void)(),
    alert: all.find((node) => node.props.role === "alert"),
    done: done ? text(done) : null,
  };
}

beforeEach(() => {
  harness.reset();
  focus.mockReset();
  complete.mockReset();
  refresh.mockReset();
});

describe("lesson completion focus (S6)", () => {
  it("moves focus once when local success arrives before the refreshed completion", async () => {
    complete.mockResolvedValue({ ok: true, data: null });
    render(null).click();
    await harness.settle();
    render(null);
    expect(focus).not.toHaveBeenCalled();
    render("Oct 24, 2026");
    render("Oct 24, 2026");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("moves focus when the refreshed completion arrives before local success", async () => {
    let resolve!: (value: ActionResult<TrainingActionError, unknown>) => void;
    complete.mockReturnValue(new Promise((done) => (resolve = done)));
    render(null).click();
    render("Oct 24, 2026");
    expect(focus).not.toHaveBeenCalled();
    resolve({ ok: true, data: null });
    await harness.settle();
    render("Oct 24, 2026");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("never moves focus when an already-completed lesson is opened", () => {
    render("Oct 1, 2026");
    render("Oct 1, 2026");
    expect(focus).not.toHaveBeenCalled();
  });

  it("waits during a renewal, whose old receipt has no label", async () => {
    complete.mockResolvedValue({ ok: true, data: null });
    render(null).click();
    await harness.settle();
    // Local success shows "completed now", but the refresh has not confirmed it.
    expect(render(null).done).toBe("completedNow");
    expect(focus).not.toHaveBeenCalled();
    render("Oct 24, 2026");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("hides an earlier refusal once the completion is authoritative", async () => {
    complete.mockResolvedValue({ ok: false, code: "failed" });
    render(null).click();
    await harness.settle();
    expect(render(null).alert).toBeDefined();
    expect(refresh).toHaveBeenCalledOnce();
    const view = render("Oct 24, 2026");
    expect(view.alert).toBeUndefined();
    expect(focus).not.toHaveBeenCalled();
  });
});
