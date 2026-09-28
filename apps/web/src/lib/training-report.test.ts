import { describe, expect, it } from "vitest";
import {
  countCompletedUsers,
  courseLessons,
  trainingReport,
  trainingStaff,
  type CourseProgress,
} from "./training-report";
import type { Course, Lesson, LessonProgress } from "./types";

/**
 * The /manage/training completion report (WD02: moved out of the page
 * unchanged). Fail closed: a failed or truncated input never renders a
 * number.
 */

const lesson = (id: number, order: number | null, documentId?: string): Lesson => ({
  id,
  title: `L${id}`,
  order,
  documentId: documentId ?? `les${String(id).padStart(21, "0")}`,
});
const course = (id: number, lessons: Lesson[]): Course => ({
  id,
  title: `C${id}`,
  slug: `c${id}`,
  mandatory: true,
  lessons,
});
const progress = (userId: number | null, lessonDocId: string): LessonProgress => ({
  id: 0,
  targetDocumentId: lessonDocId,
  user: userId === null ? null : { id: userId },
});
const staffOf = (...ids: number[]) => ids.map((id) => ({ id }));

describe("trainingStaff", () => {
  /** What the page passes: the roles with course.find. */
  const TRAINING_ROLES = new Set([
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
    "authenticated",
  ]);

  it("keeps unblocked users of a training role only", () => {
    const users = [
      { id: 1, role: { type: "member" } },
      { id: 2, role: { type: "member" }, blocked: true },
      { id: 3, role: { type: "guest" } },
      { id: 4, role: null },
      { id: 5 },
      { id: 6, role: { type: "admin_role" }, blocked: false },
      { id: 7, role: { type: "authenticated" } },
    ];
    expect(trainingStaff(users, TRAINING_ROLES).map((u) => u.id)).toEqual([1, 6, 7]);
  });
});

describe("courseLessons", () => {
  it("sorts by order, then id, and drops lessons without a documentId", () => {
    const { lessons, lessonIds } = courseLessons(
      course(1, [lesson(3, 2), lesson(1, 1), lesson(2, 1), lesson(4, 0, "")]),
    );
    expect(lessons.map((l) => l.id)).toEqual([4, 1, 2, 3]);
    expect(lessonIds).toEqual([
      lesson(1, 1).documentId,
      lesson(2, 1).documentId,
      lesson(3, 2).documentId,
    ]);
  });
});

describe("countCompletedUsers", () => {
  const lessons = [lesson(1, 1), lesson(2, 2)];
  const [a, b] = lessons.map((l) => l.documentId!);

  it("counts staff who completed every current lesson, duplicates and strangers ignored", () => {
    const rows = [
      progress(1, a!),
      progress(1, b!),
      progress(1, b!), // duplicate receipt
      progress(2, a!), // half done
      progress(99, a!), // not staff (blocked, guest, …)
      progress(99, b!),
      progress(null, a!), // user gone
    ];
    expect(countCompletedUsers(lessons, rows, staffOf(1, 2, 3))).toBe(1);
  });

  it("never counts a 0-lesson course as done", () => {
    expect(countCompletedUsers([], [progress(1, "x")], staffOf(1))).toBe(0);
  });
});

describe("trainingReport", () => {
  const withLessons = course(1, [lesson(1, 1), lesson(2, 2)]);
  const lessonDocs = (withLessons.lessons ?? []).map((l) => l.documentId!);
  const allDone = (userId: number) => lessonDocs.map((doc) => progress(userId, doc));

  const report = (
    courses: Course[],
    progressOf: (course: Course) => CourseProgress,
    flags: { coursesTruncated?: boolean; usersTruncated?: boolean; staff?: { id: number }[] } = {},
  ) =>
    trainingReport({
      courses,
      coursesTruncated: flags.coursesTruncated ?? false,
      usersTruncated: flags.usersTruncated ?? false,
      staff: flags.staff ?? staffOf(1, 2, 3),
      progressOf,
    });

  it.each([
    [1, 3, 33],
    [2, 3, 67],
    [3, 3, 100],
    [1, 8, 13], // 12.5 rounds half up
  ])("reports %i of %i done as %i%%", (done, total, pct) => {
    const staff = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
    const rows = staff.slice(0, done).flatMap((u) => allDone(u.id));
    const result = report([withLessons], () => ({ rows, truncated: false }), { staff });
    expect(result.denominator).toBe(total);
    expect(result.anyTruncated).toBe(false);
    expect(result.rows[0]).toMatchObject({
      lessonCount: 2,
      completedUsers: done,
      truncated: false,
      unknown: false,
      pct,
    });
  });

  it("reports a 0-lesson course as 0 done, without asking for its progress", () => {
    const asked: number[] = [];
    const result = report([course(2, [])], (c) => {
      asked.push(c.id);
      return { rows: [], truncated: false };
    });
    expect(asked).toEqual([]);
    expect(result.rows[0]).toMatchObject({ lessonCount: 0, completedUsers: 0, pct: 0 });
  });

  it("shows no rate without anybody to count", () => {
    const result = report([withLessons], () => ({ rows: [], truncated: false }), { staff: [] });
    expect(result.rows[0]).toMatchObject({ unknown: false, pct: null, completedUsers: 0 });
  });

  it("makes a failed progress walk that row's unknown, and flags the report", () => {
    const other = course(2, [lesson(5, 1)]);
    const result = report([withLessons, other], (c) =>
      c.id === withLessons.id ? null : { rows: [], truncated: false },
    );
    expect(result.anyTruncated).toBe(true);
    expect(result.rows[0]).toMatchObject({ completedUsers: null, truncated: true, unknown: true });
    expect(result.rows[0]!.pct).toBeNull();
    // Any truncation suppresses EVERY row's numbers.
    expect(result.rows[1]).toMatchObject({ truncated: false, unknown: true, pct: null });
  });

  it.each([
    ["courses", { coursesTruncated: true }],
    ["users", { usersTruncated: true }],
  ] as const)("suppresses every number when the %s walk was truncated", (_label, flags) => {
    const result = report([withLessons], () => ({ rows: allDone(1), truncated: false }), flags);
    expect(result.anyTruncated).toBe(true);
    expect(result.rows[0]).toMatchObject({ completedUsers: 1, unknown: true, pct: null });
  });

  it("suppresses every number when one course's progress walk was truncated", () => {
    const result = report([withLessons], () => ({ rows: allDone(1), truncated: true }));
    expect(result.anyTruncated).toBe(true);
    expect(result.rows[0]).toMatchObject({ truncated: true, unknown: true, pct: null });
  });
});
