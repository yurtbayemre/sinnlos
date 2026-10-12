import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: one training overview for the dashboard banner and /training, and
 * the course page on the same progress read, from mocked reads (the course
 * walk, the course by slug, the caller's progress walk); the completion
 * rules (lib/training-shared.ts) are real. Snapshots per scenario: success,
 * partial failure, truncation, CMS down.
 */
const reads = {
  courses: vi.fn<() => Promise<unknown>>(),
  course: vi.fn<(slug: string) => Promise<unknown>>(),
  progress: vi.fn<() => Promise<unknown>>(),
};

vi.mock("@/lib/training", () => ({
  fetchCourses: () => reads.courses(),
  fetchCourseBySlug: (slug: string) => reads.course(slug),
  fetchMyProgress: () => reads.progress(),
}));

const { loadTrainingOverview, loadCourse } = await import("./training");

const lesson = (id: number, order: number) => ({
  id,
  documentId: `lesson-${id}`,
  title: `Lesson ${id}`,
  order,
});
const SECURITY = {
  id: 1,
  documentId: "course-1",
  slug: "security",
  title: "Security basics",
  mandatory: true,
  // Out of order on purpose: the course page sorts by order, then id.
  lessons: [lesson(12, 2), lesson(11, 1), lesson(13, 3)],
};
const ONBOARDING = {
  id: 2,
  documentId: "course-2",
  slug: "onboarding",
  title: "Onboarding",
  mandatory: true,
  lessons: [lesson(21, 1)],
};
const EMPTY_COURSE = {
  id: 3,
  documentId: "course-3",
  slug: "soon",
  title: "Coming soon",
  mandatory: true,
  lessons: [],
};
const OPTIONAL = {
  id: 4,
  documentId: "course-4",
  slug: "excel",
  title: "Excel",
  mandatory: false,
  lessons: [lesson(41, 1)],
};
const COURSES = { courses: [SECURITY, ONBOARDING, EMPTY_COURSE, OPTIONAL], truncated: false };
/** Lesson 11 done; onboarding complete. */
const PROGRESS = {
  completed: new Map([
    ["lesson-11", "2026-09-20T08:00:00.000Z"],
    ["lesson-21", "2026-09-21T08:00:00.000Z"],
  ]),
  truncated: false,
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  reads.courses.mockReset().mockResolvedValue(COURSES);
  reads.course.mockReset().mockResolvedValue(SECURITY);
  reads.progress.mockReset().mockResolvedValue(PROGRESS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadTrainingOverview (banner and list)", () => {
  it("success: completion per course, open mandatory courses with lessons", async () => {
    const view = await loadTrainingOverview();
    expect(view.courses.map((c) => [c.course.slug, c.completed, c.total, c.done])).toEqual([
      ["security", 1, 3, false],
      ["onboarding", 1, 1, true],
      ["soon", 0, 0, false],
      ["excel", 0, 1, false],
    ]);
    // Security only: onboarding is done, "soon" has no lessons, excel is optional.
    expect(view.openMandatory).toBe(1);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no progress, the courses stay, the status is unknown", async () => {
    reads.progress.mockRejectedValue(outage());
    const view = await loadTrainingOverview();
    expect(view).toMatchObject({ failed: true, statusUnknown: true, openMandatory: null });
    expect(view.courses).toHaveLength(4);
    expect(view).toMatchSnapshot();
  });

  it("truncated: a cut walk makes the status unknown and keeps the banner away", async () => {
    reads.progress.mockResolvedValue({ ...PROGRESS, truncated: true });
    const view = await loadTrainingOverview();
    expect(view).toMatchObject({
      failed: false,
      truncated: true,
      statusUnknown: true,
      openMandatory: null,
    });
    expect(view).toMatchSnapshot();
    reads.progress.mockResolvedValue(PROGRESS);
    reads.courses.mockResolvedValue({ ...COURSES, truncated: true });
    await expect(loadTrainingOverview()).resolves.toMatchObject({ statusUnknown: true });
  });

  it("CMS down: the banner on the list, no courses and no empty state", async () => {
    reads.courses.mockRejectedValue(outage());
    reads.progress.mockRejectedValue(outage());
    const view = await loadTrainingOverview();
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ courses: [], empty: false, failed: true, openMandatory: null });
  });

  it("no course at all is the empty state", async () => {
    reads.courses.mockResolvedValue({ courses: [], truncated: false });
    await expect(loadTrainingOverview()).resolves.toMatchObject({
      empty: true,
      failed: false,
      openMandatory: 0,
    });
  });
});

describe("loadCourse (the course page)", () => {
  it("success: lessons in course order with completion, the first open one", async () => {
    const page = await loadCourse("security");
    expect(reads.course).toHaveBeenCalledWith("security");
    expect(page?.lessons.map((l) => [l.lesson.id, l.done])).toEqual([
      [11, true],
      [12, false],
      [13, false],
    ]);
    expect(page?.firstOpen?.id).toBe(12);
    expect(page).toMatchObject({ total: 3, completed: 1, done: false, statusUnknown: false });
    expect(page).toMatchSnapshot();
  });

  it("an unknown course is null (the page answers 404)", async () => {
    reads.course.mockResolvedValue(null);
    await expect(loadCourse("nope")).resolves.toBeNull();
  });

  it("a failed course read throws (WD07: the error boundary)", async () => {
    const error = outage();
    reads.course.mockRejectedValue(error);
    await expect(loadCourse("security")).rejects.toBe(error);
  });

  it("without the progress the status is unknown", async () => {
    reads.progress.mockRejectedValue(outage());
    const page = await loadCourse("security");
    expect(page).toMatchObject({ statusUnknown: true, completed: 0 });
    expect(page?.firstOpen?.id).toBe(11);
  });
});

describe("control flow", () => {
  it("never swallows the expired-session redirect of a read", async () => {
    const expired = (() => {
      try {
        redirect("/sign-in?expired=1");
      } catch (e) {
        return e;
      }
    })();
    reads.progress.mockRejectedValue(expired);
    await expect(loadTrainingOverview()).rejects.toBe(expired);
    await expect(loadCourse("security")).rejects.toBe(expired);
  });
});
