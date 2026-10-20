import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseEditable, LessonEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";

/** Replay the real editor hooks in Node, as the quiz feedback tests do. */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let pending: Promise<unknown>[] = [];
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
      pending = [];
    },
    begin() {
      cursor = 0;
    },
    async settle() {
      while (pending.length) {
        const current = pending;
        pending = [];
        await Promise.all(current);
      }
    },
    useState,
    useRef<T>(value: T) {
      return useState({ current: value })[0];
    },
    useTransition(): [boolean, (fn: () => unknown) => void] {
      return [
        false,
        (fn) => {
          pending.push(Promise.resolve(fn()));
        },
      ];
    },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: harness.useState,
  useRef: harness.useRef,
  useTransition: harness.useTransition,
  useEffect: () => undefined,
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => false }),
}));
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => router,
}));
vi.mock("./flash", () => ({ useManageFlash: () => vi.fn() }));
const save = vi.fn();
const upload = vi.fn();
vi.mock("@/lib/manage/training-actions", () => ({
  saveCourse: (...args: unknown[]) => save(...args),
  saveLesson: (...args: unknown[]) => save(...args),
  publishCourse: vi.fn(),
  unpublishCourse: vi.fn(),
  discardCourse: vi.fn(),
  publishLesson: vi.fn(),
  unpublishLesson: vi.fn(),
  discardLesson: vi.fn(),
}));
vi.mock("@/lib/manage/upload", () => ({
  uploadImageFile: (...args: unknown[]) => upload(...args),
}));
const { TrainingCourseEditor } = await import("./training-course-editor");
const { TrainingLessonEditor } = await import("./training-lesson-editor");
const { QuizBuilder } = await import("./quiz-builder");
const { PublishBar } = await import("./publish-bar");
const { ConflictDialog } = await import("./editor-chrome");
const { FileField } = await import("./file-field");
const { ScheduleDialog } = await import("./schedule-dialog");
type Props = Record<string, unknown> & { children?: ReactNode };
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) for (const child of node) yield* elements(child);
  else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}
const access: AreaAccess = {
  area: "courses",
  scope: "any",
  roleClass: "moderator",
  verbs: ["create", "edit", "publish", "unpublish", "schedule", "discard"],
};
const course: CourseEditable = {
  documentId: "c".repeat(24),
  version: "1",
  status: "draft",
  publishedAt: null,
  updatedAt: "2026-10-17T10:00:00Z",
  roleClass: "moderator",
  title: "Course",
  slug: "course",
  description: null,
  mandatory: false,
  completionMode: "exam",
  validityMonths: null,
  departments: [],
  needsRetarget: false,
  coverImage: null,
  publishAt: null,
  scheduleError: null,
};
const quiz = [
  { question: "First?", options: ["A", "B"], correctIndex: 1 },
  { question: "Second?", options: ["C", "D"], correctIndex: 0 },
];
const lesson: LessonEditable = {
  ...course,
  documentId: "l".repeat(24),
  course,
  body: "Body",
  order: 0,
  videoUrl: null,
  quiz,
};
function render(kind: "lesson" | "course", fresh: LessonEditable = lesson) {
  harness.begin();
  const tree =
    kind === "lesson"
      ? TrainingLessonEditor({
          editable: fresh,
          course,
          access: { ...access, area: "lessons" },
          timeZone: "Europe/Berlin",
        })
      : TrainingCourseEditor({
          editable: course,
          access,
          timeZone: "Europe/Berlin",
          departments: [],
          optionsFailed: false,
          optionsTruncated: false,
        });
  const all = [...elements(tree)];
  return {
    quiz: all.find((n) => n.type === QuizBuilder)?.props as unknown as Parameters<
      typeof QuizBuilder
    >[0],
    bar: all.find((n) => n.type === PublishBar)!.props as unknown as Parameters<
      typeof PublishBar
    >[0],
    conflict: all.find((n) => n.type === ConflictDialog)!.props as unknown as Parameters<
      typeof ConflictDialog
    >[0],
    file: all.find((n) => n.type === FileField)?.props as unknown as Parameters<
      typeof FileField
    >[0],
    schedule: all.find((n) => n.type === ScheduleDialog)!.props as unknown as Parameters<
      typeof ScheduleDialog
    >[0],
  };
}
beforeEach(() => {
  vi.stubGlobal("HTMLElement", class {});
  harness.reset();
  save.mockReset().mockResolvedValue({
    ok: true,
    data: { documentId: lesson.documentId, version: "2", status: "draft", publishedAt: null },
  });
  upload.mockReset();
  router.refresh.mockReset();
});

describe("training editor saves and reset", () => {
  it.each(["answer", "text", "order"] as const)(
    "detects %s changes, saves the full quiz and becomes clean",
    async (change) => {
      expect(render("lesson").bar.dirty).toBe(false);
      const changed =
        change === "order"
          ? [...quiz].reverse()
          : quiz.map((q, i) =>
              i
                ? q
                : {
                    ...q,
                    ...(change === "answer" ? { correctIndex: 0 } : { question: "New question?" }),
                  },
            );
      render("lesson").quiz.onChange(changed);
      expect(render("lesson").bar.dirty).toBe(true);
      render("lesson").bar.handlers.saveDraft();
      await harness.settle();
      expect(save.mock.calls[0][0].values.quiz).toEqual(changed);
      expect(render("lesson").bar.dirty).toBe(false);
    },
  );
  it("reload after conflict resets quiz values to the fresh editable", async () => {
    render("lesson").quiz.onChange([...quiz].reverse());
    save.mockResolvedValueOnce({ ok: false, code: "conflict", version: "3" });
    render("lesson").bar.handlers.saveDraft();
    await harness.settle();
    render("lesson").conflict.onReload();
    const fresh = { ...lesson, version: "3", quiz: [quiz[1]] };
    render("lesson", fresh);
    const view = render("lesson", fresh);
    expect(view.quiz.value).toEqual(fresh.quiz);
    expect(view.bar.dirty).toBe(false);
    expect(router.refresh).toHaveBeenCalled();
  });
  it("uploads once and reuses the uploaded ID for a conflict overwrite", async () => {
    const image = {
      id: 42,
      name: "cover.png",
      mime: "image/png",
      size: 1,
      url: "/uploads/cover.png",
    };
    upload.mockResolvedValue({ ok: true, data: image });
    save
      .mockResolvedValueOnce({ ok: false, code: "conflict", version: "7" })
      .mockResolvedValueOnce({ ok: true, data: { ...course, version: "8" } });
    render("course").file.onPick(new File(["image"], "cover.png", { type: "image/png" }));
    render("course").bar.handlers.saveDraft();
    await harness.settle();
    expect(render("course").file.current?.id).toBe(42);
    render("course").conflict.onOverwrite();
    await harness.settle();
    expect(upload).toHaveBeenCalledOnce();
    expect(save.mock.calls.map((call) => call[0].values.coverImage.id)).toEqual([42, 42]);
    expect(save.mock.calls.map((call) => call[0].version)).toEqual(["1", "7"]);
  });
  it("closes scheduling when upload fails and never submits the save", async () => {
    upload.mockResolvedValue({ ok: false, code: "invalid", fields: { file: "fileType" } });
    render("course").file.onPick(new File(["image"], "cover.png", { type: "image/png" }));
    render("course").schedule.onOpenChange(true);
    expect(render("course").schedule.open).toBe(true);
    render("course").schedule.onSave({
      publishDate: "2030-01-01",
      publishTime: "10:00",
      unpublishDate: "",
      unpublishTime: "",
    });
    await harness.settle();
    expect(render("course").schedule.open).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
