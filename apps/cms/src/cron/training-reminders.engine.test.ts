/**
 * The training expiry reminders (cron/training-reminders.ts) against
 * Strapi's real query engine on SQLite: the roster reads, the anchored
 * dedup and the notification writes the cron runs. Pinned: due soon and
 * expired notify once per reminder cycle, a rerun writes nothing, a missed
 * day catches up, a renewal starts a new cycle; courses without validity,
 * optional or unpublished courses, users outside the audience, blocked users
 * and guests are never reminded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openSqliteEngine, type SqliteEngine } from "../test/sqlite-engine.test.helper";
import { sendTrainingReminders } from "./training-reminders";

const USER_UID = "plugin::users-permissions.user";
const ROLE_UID = "plugin::users-permissions.role";
const DEPARTMENT_UID = "api::department.department";
const COURSE_UID = "api::course.course";
const LESSON_UID = "api::lesson.lesson";
const PROGRESS_UID = "api::lesson-progress.lesson-progress";
const NOTIFICATION_UID = "api::notification.notification";

const MODELS = [
  {
    uid: ROLE_UID,
    singularName: "role",
    tableName: "up_roles",
    attributes: { id: { type: "increments" }, type: { type: "string" } },
  },
  {
    uid: DEPARTMENT_UID,
    singularName: "department",
    tableName: "departments",
    attributes: { id: { type: "increments" }, name: { type: "string" } },
  },
  {
    uid: USER_UID,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      username: { type: "string" },
      displayName: { type: "string" },
      email: { type: "string" },
      blocked: { type: "boolean" },
      role: { type: "relation", relation: "manyToOne", target: ROLE_UID },
      department: { type: "relation", relation: "manyToOne", target: DEPARTMENT_UID },
    },
  },
  {
    uid: COURSE_UID,
    singularName: "course",
    tableName: "courses",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      title: { type: "string" },
      slug: { type: "string" },
      mandatory: { type: "boolean" },
      validityMonths: { type: "integer" },
      audience: { type: "string" },
      publishedAt: { type: "datetime" },
      departments: { type: "relation", relation: "manyToMany", target: DEPARTMENT_UID },
      lessons: { type: "relation", relation: "oneToMany", target: LESSON_UID, mappedBy: "course" },
    },
  },
  {
    uid: LESSON_UID,
    singularName: "lesson",
    tableName: "lessons",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      title: { type: "string" },
      order: { type: "integer" },
      publishedAt: { type: "datetime" },
      course: {
        type: "relation",
        relation: "manyToOne",
        target: COURSE_UID,
        inversedBy: "lessons",
      },
    },
  },
  {
    uid: PROGRESS_UID,
    singularName: "lesson-progress",
    tableName: "lesson_progresses",
    attributes: {
      id: { type: "increments" },
      targetDocumentId: { type: "string" },
      completedAt: { type: "datetime" },
      user: { type: "relation", relation: "manyToOne", target: USER_UID },
    },
  },
  {
    uid: NOTIFICATION_UID,
    singularName: "notification",
    tableName: "notifications",
    attributes: {
      id: { type: "increments" },
      type: { type: "string" },
      title: { type: "string" },
      titleParams: { type: "json" },
      link: { type: "string" },
      readAt: { type: "datetime" },
      sourceType: { type: "string" },
      sourceDocumentId: { type: "string" },
      recipient: { type: "relation", relation: "manyToOne", target: USER_UID },
      actor: { type: "relation", relation: "manyToOne", target: USER_UID },
    },
  },
];

type Row = Record<string, unknown>;

let engine: SqliteEngine;
const q = (uid: string) => engine.db.query(uid);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const run = (today: string) =>
  sendTrainingReminders({ db: engine.db, log } as never, today, "Europe/Berlin");

const ids: Record<string, number> = {};

async function complete(user: string, lessons: string[], completedAt: string) {
  for (const lesson of lessons) {
    await q(PROGRESS_UID).create({
      data: { user: ids[user], targetDocumentId: lesson, completedAt },
    });
  }
}

async function notifications(): Promise<Row[]> {
  return q(NOTIFICATION_UID).findMany({
    select: ["type", "title", "titleParams", "link", "sourceType", "sourceDocumentId"],
    populate: { recipient: { select: ["username"] } },
    orderBy: [{ id: "asc" }],
  });
}

const summary = (rows: Row[]) =>
  rows.map((row) => [(row.recipient as Row).username, row.type, row.sourceDocumentId]);

beforeEach(async () => {
  engine = await openSqliteEngine(MODELS);
  log.info.mockReset();
  log.warn.mockReset();
  log.error.mockReset();
  const member = await q(ROLE_UID).create({ data: { type: "member" } });
  const guest = await q(ROLE_UID).create({ data: { type: "guest" } });
  const lager = await q(DEPARTMENT_UID).create({ data: { name: "Lager" } });
  const buero = await q(DEPARTMENT_UID).create({ data: { name: "Büro" } });
  const users: [string, number, number, boolean?][] = [
    ["alice", member.id as number, lager.id as number],
    ["bob", member.id as number, lager.id as number],
    ["carl", member.id as number, buero.id as number],
    ["dora", member.id as number, lager.id as number, true],
    ["gina", guest.id as number, lager.id as number],
    ["eve", member.id as number, lager.id as number],
    ["finn", member.id as number, lager.id as number],
  ];
  for (const [username, role, department, blocked] of users) {
    const user = await q(USER_UID).create({
      data: { username, displayName: username, role, department, blocked: blocked ?? false },
    });
    ids[username] = user.id as number;
  }
  const published = "2026-01-01T00:00:00.000Z";
  const course = async (data: Row, lessons: string[]) => {
    const row = await q(COURSE_UID).create({
      data: { mandatory: true, audience: "all", publishedAt: published, ...data },
    });
    for (const [order, documentId] of lessons.entries()) {
      await q(LESSON_UID).create({
        data: { documentId, title: documentId, order, publishedAt: published, course: row.id },
      });
    }
  };
  await course(
    {
      documentId: "stapler",
      title: "Stapler",
      slug: "stapler",
      validityMonths: 12,
      audience: "departments",
      departments: [lager.id],
    },
    ["s1", "s2"],
  );
  await course({ documentId: "privacy", title: "Datenschutz", slug: "privacy" }, ["p1"]);
  await course(
    {
      documentId: "optional",
      title: "Optional",
      slug: "optional",
      validityMonths: 12,
      mandatory: false,
    },
    ["o1"],
  );
  await course(
    { documentId: "draft", title: "Draft", slug: "draft", validityMonths: 12, publishedAt: null },
    ["d1"],
  );

  await complete("alice", ["s1", "s2"], "2025-11-10T08:00:00.000Z");
  await complete("bob", ["s1", "s2"], "2025-09-01T08:00:00.000Z");
  await complete("carl", ["s1", "s2"], "2024-01-01T08:00:00.000Z");
  await complete("dora", ["s1", "s2"], "2024-01-01T08:00:00.000Z");
  await complete("gina", ["s1", "s2"], "2024-01-01T08:00:00.000Z");
  await complete("eve", ["s1", "s2"], "2026-05-01T08:00:00.000Z");
  await complete("finn", ["s1"], "2024-01-01T08:00:00.000Z");
  for (const user of ["alice", "bob", "eve"]) {
    await complete(user, ["p1"], "2020-01-01T08:00:00.000Z");
    await complete(user, ["o1", "d1"], "2020-01-01T08:00:00.000Z");
  }
});

afterEach(async () => {
  await engine.close();
});

describe("sendTrainingReminders", () => {
  it("reminds due-soon and expired learners of the audience once per cycle", async () => {
    expect(await run("2026-10-20")).toBe(2);
    const rows = await notifications();
    expect(summary(rows)).toEqual([
      ["alice", "trainingDue", "stapler@2026-11-10:soon"],
      ["bob", "trainingExpired", "stapler@2026-09-01:expired"],
    ]);
    expect(rows[0]).toMatchObject({
      title: 'Training "Stapler" is due soon',
      titleParams: { subject: "Stapler" },
      link: "/training/stapler",
      sourceType: "course",
    });
    expect(log.error).not.toHaveBeenCalled();

    // A rerun (restart, manual invoke) writes nothing.
    expect(await run("2026-10-20")).toBe(0);
    expect(await notifications()).toHaveLength(2);
  });

  it("catches up after missed days and starts a new cycle after a renewal", async () => {
    await run("2026-10-20");
    // Two days after alice's due day: her expiry, nothing new for bob.
    expect(await run("2026-11-12")).toBe(1);
    // bob renews; a year later his next cycle is due soon (and eve's expired).
    await complete("bob", ["s1", "s2"], "2026-11-12T09:00:00.000Z");
    expect(await run("2027-10-20")).toBe(2);
    expect(summary((await notifications()).slice(2))).toEqual([
      ["alice", "trainingExpired", "stapler@2026-11-10:expired"],
      ["bob", "trainingDue", "stapler@2027-11-12:soon"],
      ["eve", "trainingExpired", "stapler@2027-05-01:expired"],
    ]);
  });

  it("writes nothing when no mandatory published course has a validity", async () => {
    await q(COURSE_UID).delete({ where: { documentId: "stapler" } });
    expect(await run("2026-10-20")).toBe(0);
    expect(await notifications()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "[training-reminders] no mandatory course with a validity",
    );
  });
});
