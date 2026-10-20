import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoursePage, TrainingOverview } from "@/lib/loaders/training";
import { render } from "@/components/manage/render.test.helper";
const courseLoad = vi.fn();
const overviewLoad = vi.fn();
vi.mock("@/lib/loaders/training", () => ({
  loadCourse: (...args: unknown[]) => courseLoad(...args),
  loadTrainingOverview: (...args: unknown[]) => overviewLoad(...args),
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 1, role: "member", department: null }),
}));
vi.mock("@/lib/training", () => ({ fetchCourseBySlug: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "de",
}));
const { default: CoursePageComponent } = await import("./[slug]/page");
const { default: OverviewPage } = await import("./page");
const course: CoursePage["course"] = {
  id: 1,
  documentId: "c".repeat(24),
  slug: "course",
  title: "Course",
  mandatory: false,
  description: "**Bold** and [link](https://example.com)",
  coverImage: {
    url: "/uploads/cover.png",
    formats: { small: { url: "/uploads/small_cover.png" } },
  },
};
const detail: CoursePage = {
  course,
  lessons: [],
  total: 0,
  completed: 0,
  done: false,
  status: "open",
  dueKey: null,
  statusUnknown: false,
  firstOpen: null,
};
const overview: TrainingOverview = {
  courses: [{ course, total: 0, completed: 0, done: false, status: "open", dueKey: null }],
  statusUnknown: false,
  openMandatory: 0,
  dueSoonMandatory: 0,
  empty: false,
  failed: false,
  truncated: false,
};
beforeEach(() => {
  courseLoad.mockReset().mockResolvedValue(detail);
  overviewLoad.mockReset().mockResolvedValue(overview);
});

describe("recurring course status (v0.20)", () => {
  it("shows expired, due soon and the next renewal with the due day", async () => {
    overviewLoad.mockResolvedValue({
      ...overview,
      courses: [
        { course, total: 1, completed: 0, done: false, status: "expired", dueKey: "2026-10-01" },
        {
          course: { ...course, id: 2 },
          total: 1,
          completed: 1,
          done: true,
          status: "dueSoon",
          dueKey: "2026-11-01",
        },
        {
          course: { ...course, id: 3 },
          total: 1,
          completed: 1,
          done: true,
          status: "done",
          dueKey: "2027-10-01",
        },
      ],
    });
    const html = render(await OverviewPage());
    for (const key of ["statusExpired", "statusDueSoon", "nextRenewal", "statusDone"]) {
      expect(html).toContain(key);
    }
  });
  it("offers renewal on the course page and marks the lessons to renew", async () => {
    courseLoad.mockResolvedValue({
      ...detail,
      course: { ...course, validityMonths: 12 },
      lessons: [
        {
          lesson: { id: 5, documentId: "l".repeat(24), title: "L1", order: 0 },
          done: true,
          renew: true,
        },
      ],
      total: 1,
      completed: 1,
      done: true,
      status: "dueSoon",
      dueKey: "2026-11-01",
      firstOpen: { id: 5, documentId: "l".repeat(24), title: "L1", order: 0 },
    });
    const html = render(await CoursePageComponent({ params: Promise.resolve({ slug: "course" }) }));
    expect(html).toContain("repeatEvery");
    expect(html).toContain("renewCourse");
    expect(html).toContain("lessonRenew");
  });
});

describe("published training presentation", () => {
  it("shows the cover directly and renders safe Markdown on detail", async () => {
    const html = render(await CoursePageComponent({ params: Promise.resolve({ slug: "course" }) }));
    expect(html).toContain('src="/uploads/cover.png"');
    expect(html).not.toContain("/_next/image");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('href="https://example.com"');
  });
  it("uses an existing thumbnail and plain summary in the linked overview card", async () => {
    const html = render(await OverviewPage());
    expect(html).toContain('src="/uploads/small_cover.png"');
    expect(html).toContain("Bold and link");
    expect(html).not.toContain("**Bold**");
    expect(html).not.toContain('href="https://example.com"');
  });
  it("keeps a course without an image, hostile links and raw HTML inert", async () => {
    courseLoad.mockResolvedValue({
      ...detail,
      course: {
        ...course,
        coverImage: null,
        description: "<script>alert(1)</script> [bad](javascript:alert(1))",
      },
    });
    const html = render(await CoursePageComponent({ params: Promise.resolve({ slug: "course" }) }));
    expect(html).not.toMatch(/<(img|script)[^>]*>/);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
  });
});
