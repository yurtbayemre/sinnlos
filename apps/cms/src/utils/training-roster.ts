import type { Core } from "@strapi/strapi";
import { isInScopedAudience, newestReceipts } from "@sinnlos/domain";

import { TRAINING_LEARNER_ROLES } from "../bootstrap/roles";
import { chunks } from "./authoring-controller";
import { NOT_BLOCKED } from "./visible-ids";

/**
 * The shared reads of the training report and the expiry reminders (v0.20):
 * published courses with their published lessons and audience, the
 * learners (unblocked users of a learner role), and each learner's newest
 * receipt per lesson. Server-side only: progress is personnel data, the
 * callers decide who sees what.
 */

const COURSE_UID = "api::course.course";
const USER_UID = "plugin::users-permissions.user";
const PROGRESS_UID = "api::lesson-progress.lesson-progress";
const ID_CHUNK = 500;
/**
 * Receipts per query (v0.32, #176): the user populate binds every returned
 * row id, so a result page must stay below Postgres's 65,535 parameters,
 * however many receipts (lessons × renewals) a chunk of learners holds.
 */
export const RECEIPT_PAGE = 5000;

type DbStrapi = Pick<Core.Strapi, "db">;

export interface RosterCourse {
  id: number;
  documentId: string;
  title: string;
  slug: string;
  mandatory: boolean;
  validityMonths: number | null;
  audience: string | null;
  departments: { id: number; name: string }[];
  /** Published lessons in course order (order, then id). */
  lessons: { documentId: string; title: string }[];
}

export interface RosterUser {
  id: number;
  name: string;
  email: string | null;
  departmentId: number | null;
  departmentName: string | null;
}

/** The row shapes the queries below select (db.query rows, read defensively). */
interface CourseRow {
  id: number;
  documentId: string;
  title?: string | null;
  slug?: string | null;
  mandatory?: boolean | null;
  validityMonths?: number | null;
  audience?: string | null;
  departments?: { id: number; name?: string | null }[] | null;
  lessons?:
    | {
        id: number;
        documentId?: string | null;
        title?: string | null;
        order?: number | null;
        publishedAt?: unknown;
      }[]
    | null;
}
interface UserRow {
  id: number;
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: { type?: string | null } | null;
  department?: { id?: number; name?: string | null } | null;
}
interface ProgressRow {
  id: number;
  targetDocumentId: string;
  completedAt?: unknown;
  user?: { id?: number } | null;
}

const isRecord = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rows = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value.filter(isRecord) as T[]) : [];

/** Instants come back as Date or ISO string depending on the engine. */
export const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;

/** Published courses (mandatory only by default), with published lessons. */
export async function loadRosterCourses(
  strapi: DbStrapi,
  options: { mandatoryOnly?: boolean; documentId?: string } = {},
): Promise<RosterCourse[]> {
  const where: Record<string, unknown> = { publishedAt: { $notNull: true } };
  if (options.mandatoryOnly !== false) where.mandatory = true;
  if (options.documentId) where.documentId = options.documentId;
  const found = await strapi.db.query(COURSE_UID).findMany({
    where,
    select: ["id", "documentId", "title", "slug", "mandatory", "validityMonths", "audience"],
    populate: {
      departments: { select: ["id", "name"] },
      lessons: { select: ["id", "documentId", "title", "order", "publishedAt"] },
    },
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  return rows<CourseRow>(found).map((course) => ({
    id: course.id,
    documentId: course.documentId,
    title: course.title ?? "",
    slug: course.slug ?? "",
    mandatory: course.mandatory !== false,
    validityMonths:
      typeof course.validityMonths === "number" &&
      Number.isInteger(course.validityMonths) &&
      course.validityMonths > 0
        ? course.validityMonths
        : null,
    audience: course.audience ?? null,
    departments: rows<{ id: number; name?: string | null }>(course.departments).map((d) => ({
      id: d.id,
      name: d.name ?? "",
    })),
    lessons: rows<NonNullable<CourseRow["lessons"]>[number]>(course.lessons)
      .filter((lesson) => lesson.publishedAt != null && typeof lesson.documentId === "string")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id)
      .map((lesson) => ({ documentId: lesson.documentId as string, title: lesson.title ?? "" })),
  }));
}

/** Unblocked learners, optionally of one department only. */
export async function loadLearners(strapi: DbStrapi, departmentId?: number): Promise<RosterUser[]> {
  const where: Record<string, unknown> = { ...NOT_BLOCKED };
  if (departmentId != null) where.department = { id: departmentId };
  const found = await strapi.db.query(USER_UID).findMany({
    where,
    select: ["id", "username", "displayName", "email"],
    populate: { role: { select: ["type"] }, department: { select: ["id", "name"] } },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  });
  const learner = new Set<string>(TRAINING_LEARNER_ROLES);
  return rows<UserRow>(found)
    .filter((user) => learner.has(user.role?.type ?? ""))
    .map((user) => ({
      id: user.id,
      name: user.displayName || user.username || `#${user.id}`,
      email: typeof user.email === "string" ? user.email : null,
      departmentId: typeof user.department?.id === "number" ? user.department.id : null,
      departmentName: user.department?.name ?? null,
    }));
}

/** The learners a course is for. */
export function courseAudience(course: RosterCourse, learners: RosterUser[]): RosterUser[] {
  return learners.filter((user) => isInScopedAudience(course, user.departmentId));
}

export interface ReceiptRow {
  userId: number;
  targetDocumentId: string;
  completedAt: string | null;
}

/** Every receipt of `userIds` for `lessonIds` (the proof history), oldest first. */
export async function loadReceipts(
  strapi: DbStrapi,
  userIds: number[],
  lessonIds: string[],
): Promise<ReceiptRow[]> {
  if (userIds.length === 0 || lessonIds.length === 0) return [];
  const out: ReceiptRow[] = [];
  for (const userChunk of chunks(userIds, ID_CHUNK)) {
    for (const lessonChunk of chunks(lessonIds, ID_CHUNK)) {
      for (let afterId = 0; ;) {
        const page = rows<ProgressRow>(
          await strapi.db.query(PROGRESS_UID).findMany({
            where: {
              user: { id: { $in: userChunk } },
              targetDocumentId: { $in: lessonChunk },
              id: { $gt: afterId },
            },
            select: ["id", "targetDocumentId", "completedAt"],
            populate: { user: { select: ["id"] } },
            orderBy: [{ id: "asc" }],
            limit: RECEIPT_PAGE,
          }),
        );
        // The cursor moves with the fetched page, rows without a user included.
        if (page.length > 0) afterId = page[page.length - 1].id;
        for (const row of page) {
          if (typeof row.user?.id !== "number") continue;
          out.push({
            userId: row.user.id,
            targetDocumentId: row.targetDocumentId,
            completedAt: toIso(row.completedAt),
          });
        }
        if (page.length < RECEIPT_PAGE) break;
      }
    }
  }
  return out;
}

/** userId → newest receipt per lesson. */
export function newestByUser(receipts: ReceiptRow[]): Map<number, Map<string, string | null>> {
  const grouped = new Map<number, ReceiptRow[]>();
  for (const receipt of receipts) {
    const list = grouped.get(receipt.userId) ?? [];
    list.push(receipt);
    grouped.set(receipt.userId, list);
  }
  return new Map([...grouped].map(([userId, list]) => [userId, newestReceipts(list)]));
}
