import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CourseEditable, LessonEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { MESSAGES, render, tagById } from "./render.test.helper";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/manage/training-actions", () => ({
  saveCourse: vi.fn(),
  publishCourse: vi.fn(),
  unpublishCourse: vi.fn(),
  discardCourse: vi.fn(),
  saveLesson: vi.fn(),
  publishLesson: vi.fn(),
  unpublishLesson: vi.fn(),
  discardLesson: vi.fn(),
}));
vi.mock("@/lib/manage/upload", () => ({ uploadImageFile: vi.fn() }));
const { TrainingCourseEditor } = await import("./training-course-editor");
const { TrainingLessonEditor } = await import("./training-lesson-editor");
const { QuizBuilder, removeQuizOption } = await import("./quiz-builder");
const { CoursePreview } = await import("./training-previews");
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
const quiz = [{ question: "First?", options: ["A", "B"], correctIndex: 1 }];
const lesson: LessonEditable = {
  ...course,
  documentId: "l".repeat(24),
  course,
  body: "Body",
  order: 0,
  videoUrl: null,
  quiz,
};

describe("training editor presentation", () => {
  it("loads the course preview image directly through the session-gated upload route", () => {
    const html = render(
      createElement(CoursePreview, {
        editable: {
          ...course,
          coverImage: {
            id: 1,
            name: "cover.png",
            mime: "image/png",
            size: 1,
            url: "/uploads/cover.png",
          },
        },
      }),
    );
    expect(html).toContain('src="/uploads/cover.png"');
    expect(html).not.toContain("/_next/image");
  });
  it.each(["en", "de"] as const)(
    "renders course fields, image-only upload and receipt notice in %s",
    (locale) => {
      const html = render(
        createElement(TrainingCourseEditor, {
          editable: course,
          access,
          timeZone: "Europe/Berlin",
          departments: [{ documentId: "d".repeat(24), name: "Lager" }],
          optionsFailed: false,
          optionsTruncated: false,
        }),
        locale,
      );
      expect(html).toContain(MESSAGES[locale].manage.training.receiptsNotice);
      const file = tagById(html, "course-coverImage");
      expect(file).toContain('type="file"');
      expect(file).toContain(".png");
      expect(file).not.toContain(".pdf");
      expect(html).not.toContain(`>${MESSAGES[locale].manage.common.actions.delete}</button>`);
      expect(html).not.toContain(`>${MESSAGES[locale].manage.common.actions.discard}</button>`);
    },
  );
  it("offers discard only for a currently published version and never a web move or delete", () => {
    const html = render(
      createElement(TrainingLessonEditor, {
        editable: { ...lesson, status: "modified", publishedAt: "2026-10-17T10:00:00Z" },
        course,
        access: { ...access, area: "lessons" },
        timeZone: "Europe/Berlin",
      }),
    );
    expect(html).toContain(`>${MESSAGES.en.manage.common.actions.discard}</button>`);
    expect(tagById(html, "lesson-course")).toContain('readOnly=""');
    expect(html).not.toContain(`>${MESSAGES.en.manage.common.actions.delete}</button>`);
  });
  it("uses labelled native radio groups, bounded text fields and an error focus target", () => {
    const html = render(
      createElement(QuizBuilder, {
        id: "lesson-quiz",
        value: [{ ...quiz[0], question: "" }],
        error: "Invalid quiz",
        onChange: vi.fn(),
      }),
    );
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain('<legend class="mb-2 text-sm font-medium">Correct answer</legend>');
    expect(html).toContain('name="lesson-quiz-correct-0"');
    expect(tagById(html, "lesson-quiz")).toContain('aria-invalid="true"');
    expect(tagById(html, "lesson-quiz")).toContain('maxLength="500"');
    expect(html).toContain('role="status"');
  });
  it("deleting an answer preserves the same correct answer or requires choosing again", () => {
    const q = { question: "Q", options: ["A", "B", "C"], correctIndex: 2 };
    expect(removeQuizOption(q, 0)).toEqual({ question: "Q", options: ["B", "C"], correctIndex: 1 });
    expect(removeQuizOption(q, 2).correctIndex).toBe(-1);
    expect(removeQuizOption({ ...q, correctIndex: 0 }, 2).correctIndex).toBe(0);
  });
});
