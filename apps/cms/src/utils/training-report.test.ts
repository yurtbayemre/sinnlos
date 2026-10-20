import { describe, expect, it } from "vitest";

import { buildCourseReport } from "./training-report";
import type { RosterCourse, RosterUser } from "./training-roster";

/**
 * The named training report for one course (v0.20): today's status per
 * person from the newest receipt per CURRENT lesson, the counts, the proof
 * history, and the order (who needs to act first).
 */

const TZ = "Europe/Berlin";
const TODAY = "2026-10-20";

const course: RosterCourse = {
  id: 1,
  documentId: "c".repeat(24),
  title: "Staplerschein",
  slug: "staplerschein",
  mandatory: true,
  validityMonths: 12,
  audience: "departments",
  departments: [{ id: 4, name: "Lager" }],
  lessons: [
    { documentId: "a".repeat(24), title: "Sicherheit" },
    { documentId: "b".repeat(24), title: "Praxis" },
  ],
};

const person = (id: number, name: string): RosterUser => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.com`,
  departmentId: 4,
  departmentName: "Lager",
});

const A = course.lessons[0].documentId;
const B = course.lessons[1].documentId;

describe("buildCourseReport", () => {
  it("rates every person, counts the statuses and lists open and expired first", () => {
    const people = [person(1, "Done"), person(2, "Soon"), person(3, "Expired"), person(4, "Open")];
    const receipts = [
      { userId: 1, targetDocumentId: A, completedAt: "2026-06-01T08:00:00Z" },
      { userId: 1, targetDocumentId: B, completedAt: "2026-06-01T08:05:00Z" },
      { userId: 2, targetDocumentId: A, completedAt: "2025-11-10T08:00:00Z" },
      { userId: 2, targetDocumentId: B, completedAt: "2025-11-10T08:05:00Z" },
      { userId: 3, targetDocumentId: A, completedAt: "2025-01-10T08:00:00Z" },
      { userId: 3, targetDocumentId: B, completedAt: "2025-01-10T08:05:00Z" },
      { userId: 4, targetDocumentId: A, completedAt: "2026-10-01T08:00:00Z" },
      // A lesson removed from the course does not count and is not listed.
      { userId: 4, targetDocumentId: "z".repeat(24), completedAt: "2026-10-01T08:00:00Z" },
    ];
    const report = buildCourseReport(course, people, receipts, TODAY, TZ);
    expect(report.course).toEqual({
      documentId: course.documentId,
      title: "Staplerschein",
      slug: "staplerschein",
      validityMonths: 12,
      lessonCount: 2,
      departments: ["Lager"],
      counts: { done: 1, dueSoon: 1, expired: 1, open: 1, total: 4 },
    });
    expect(report.people.map((p) => [p.name, p.status, p.completed, p.dueKey])).toEqual([
      ["Expired", "expired", 0, "2026-01-10"],
      ["Open", "open", 1, null],
      ["Soon", "dueSoon", 2, "2026-11-10"],
      ["Done", "done", 2, "2027-06-01"],
    ]);
    const open = report.people.find((p) => p.userId === 4)!;
    expect(open.receipts).toEqual([{ lessonDocumentId: A, completedAt: "2026-10-01T08:00:00Z" }]);
    const done = report.people.find((p) => p.userId === 1)!;
    expect(done.completedAt).toBe("2026-06-01T08:05:00Z");
    expect(done.email).toBe("done@example.com");
  });

  it("keeps every receipt as proof history but rates by the newest", () => {
    const receipts = [
      { userId: 1, targetDocumentId: A, completedAt: "2025-01-10T08:00:00Z" },
      { userId: 1, targetDocumentId: B, completedAt: "2025-01-10T08:05:00Z" },
      { userId: 1, targetDocumentId: A, completedAt: "2026-01-12T08:00:00Z" },
      { userId: 1, targetDocumentId: B, completedAt: "2026-01-12T08:05:00Z" },
    ];
    const [row] = buildCourseReport(course, [person(1, "Renewed")], receipts, TODAY, TZ).people;
    expect(row.status).toBe("done");
    expect(row.dueKey).toBe("2027-01-12");
    expect(row.receipts).toHaveLength(4);
  });

  it("never expires a course without validity", () => {
    const receipts = [
      { userId: 1, targetDocumentId: A, completedAt: "2020-01-10T08:00:00Z" },
      { userId: 1, targetDocumentId: B, completedAt: "2020-01-10T08:05:00Z" },
    ];
    const once = { ...course, validityMonths: null };
    const report = buildCourseReport(once, [person(1, "Once")], receipts, TODAY, TZ);
    expect(report.people[0]).toMatchObject({ status: "done", dueKey: null });
    expect(report.course.counts).toEqual({ done: 1, dueSoon: 0, expired: 0, open: 0, total: 1 });
  });
});
