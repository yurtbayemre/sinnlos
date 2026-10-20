import {
  courseValidity,
  newestReceipts,
  type TrainingReportCourse,
  type TrainingReportPerson,
} from "@sinnlos/domain";

import type { ReceiptRow, RosterCourse, RosterUser } from "./training-roster";

/**
 * The named training report for one course (v0.20): every person the course
 * is for, with today's status, and the counts. Pure: the controller loads the
 * course, the people in the caller's scope and their receipts
 * (utils/training-roster.ts). People are sorted expired and open first, then
 * by name, so the list starts with who needs to act.
 */

const STATUS_ORDER = { expired: 0, open: 1, dueSoon: 2, done: 3 } as const;

export function buildCourseReport(
  course: RosterCourse,
  people: RosterUser[],
  receipts: ReceiptRow[],
  todayKey: string,
  timeZone: string,
): { course: TrainingReportCourse; people: TrainingReportPerson[] } {
  const lessonIds = course.lessons.map((lesson) => lesson.documentId);
  const current = new Set(lessonIds);
  const byUser = new Map<number, ReceiptRow[]>();
  for (const receipt of receipts) {
    if (!current.has(receipt.targetDocumentId)) continue;
    const list = byUser.get(receipt.userId) ?? [];
    list.push(receipt);
    byUser.set(receipt.userId, list);
  }

  const counts = { done: 0, dueSoon: 0, expired: 0, open: 0, total: people.length };
  const rows = people.map((person): TrainingReportPerson => {
    const own = byUser.get(person.id) ?? [];
    const validity = courseValidity(
      lessonIds,
      newestReceipts(own),
      course.validityMonths,
      todayKey,
      timeZone,
    );
    counts[validity.status]++;
    return {
      userId: person.id,
      name: person.name,
      email: person.email,
      department: person.departmentName,
      status: validity.status,
      completed: validity.completed,
      total: validity.total,
      completedAt: validity.completedAt,
      dueKey: validity.dueKey,
      receipts: own.map((receipt) => ({
        lessonDocumentId: receipt.targetDocumentId,
        completedAt: receipt.completedAt,
      })),
    };
  });
  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.name.localeCompare(b.name, "de") ||
      a.userId - b.userId,
  );

  return {
    course: {
      documentId: course.documentId,
      title: course.title,
      slug: course.slug,
      validityMonths: course.validityMonths,
      lessonCount: lessonIds.length,
      departments: course.departments.map((department) => department.name),
      counts,
    },
    people: rows,
  };
}
