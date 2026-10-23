import assert, { AssertionError } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {{id: number, documentId: string, email?: string, provider?: string,
 * confirmed?: boolean, blocked?: boolean, slug?: string, name?: string,
 * description?: string, role?: {type: string}, department?: Row | null,
 * lead?: Row | null, teams?: Row[], members?: Row[], title?: string, body?: string,
 * order?: number, mandatory?: boolean, completionMode?: string, publishedAt?: string | null,
 * course?: Row | null, quiz?: unknown}} Row
 * @typedef {{
 * documents(uid: string): {create(params: {data: Record<string, unknown>, status?: "published"}): Promise<Row>},
 * db: {query(uid: string): {count(): Promise<number>, findOne(params: Record<string, unknown>): Promise<Row | null>},
 * connection?: {client?: {pool?: {numUsed(): number, numPendingAcquires(): number}}}},
 * plugin(name: string): {service(name: string): {add(data: Record<string, unknown>): Promise<Row>}},
 * log: {level: string}, cron: {stop(): void}, load(): Promise<unknown>, destroy(): Promise<void>,
 * config: {set(key: string, value: unknown): void},
 * server: {httpServer: import("node:http").Server, listen(port: number, host: string, callback: () => void): unknown}
 * }} Cms
 */

const appDir = "/app/apps/cms";
const fixturePath = "/tmp/e2e-fixtures.json";
const userUid = "plugin::users-permissions.user";
const departmentUid = "api::department.department";
const teamUid = "api::team.team";
const courseUid = "api::course.course";
const lessonUid = "api::lesson.lesson";
const progressUid = "api::lesson-progress.lesson-progress";
let phase = "environment check";
/** @type {Cms | undefined} */
let strapi;
let stopping = false;

/** @param {string} key */
function fixturePassword(key) {
  const value = process.env[key];
  assert.ok(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `${key} must be 32 random bytes encoded as hex`,
  );
  return value;
}

async function start() {
  assert.equal(process.cwd(), appDir, "Run this starter only in the CMS image");
  assert.ok(existsSync("/.dockerenv"), "The E2E starter requires its disposable Docker container");
  const expected = {
    NODE_ENV: "production",
    TZ: "UTC",
    DATABASE_CLIENT: "postgres",
    DATABASE_HOST: "db",
    DATABASE_NAME: "sinnlos_e2e",
    DATABASE_USERNAME: "sinnlos_e2e",
    ENV_PATH: "/tmp/no-such-e2e.env",
    CRON_ENABLED: "0",
    DIGESTS_DISABLED: "1",
    LIVE_EVENTS_DISABLED: "1",
    ENTRA_ENABLED: "0",
    AUTH_LOCAL_ENABLED: "1",
    SEED_DEMO_DATA: "0",
    STRAPI_TELEMETRY_DISABLED: "true",
    HOST: "0.0.0.0",
    PORT: "1337",
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(process.env[key], value, `Unexpected E2E setting: ${key}`);
  }
  assert.ok(!process.env.DATABASE_URL, "DATABASE_URL is not supported by the E2E starter");
  assert.equal(process.env.DATABASE_SCHEMA ?? "public", "public", "E2E uses a fresh public schema");
  assert.ok(process.env.DATABASE_PASSWORD, "The disposable database requires a password");
  assert.ok(!existsSync("/tmp/no-such-e2e.env"), "The E2E dotenv path must not exist");
  assert.ok(!existsSync(fixturePath), "Fixtures already exist; start a fresh E2E run");
  const runId = process.env.E2E_RUN_ID;
  assert.ok(
    typeof runId === "string" && /^sinnlos-e2e-[a-f0-9]{24}$/.test(runId),
    "Missing E2E runner identity",
  );
  const fixtures = {
    runId,
    users: {
      lead: {
        email: "lead@e2e.test",
        password: fixturePassword("E2E_LEAD_PASSWORD"),
        documentId: "",
      },
      member: {
        email: "member@e2e.test",
        password: fixturePassword("E2E_MEMBER_PASSWORD"),
        documentId: "",
      },
      editor: {
        email: "editor@e2e.test",
        password: fixturePassword("E2E_EDITOR_PASSWORD"),
        documentId: "",
      },
      // v0.27: admins, whose role needs a second factor in this run
      // (MFA_REQUIRED_ROLES=admin_role): mfa.spec.ts and invite.spec.ts.
      admin: {
        email: "admin@e2e.test",
        password: fixturePassword("E2E_ADMIN_PASSWORD"),
        documentId: "",
      },
      inviter: {
        email: "inviter@e2e.test",
        password: fixturePassword("E2E_INVITER_PASSWORD"),
        documentId: "",
      },
    },
    teams: {
      editable: {
        slug: "e2e-editable",
        name: "E2E Editable Team",
        description: "Initial editable team description.",
        documentId: "",
      },
      readonly: {
        slug: "e2e-readonly",
        name: "E2E Readonly Team",
        description: "Initial readonly team description.",
        documentId: "",
      },
    },
    training: {
      course: { title: "E2E Quiz Course", slug: "e2e-quiz-course", documentId: "" },
      lesson: { title: "E2E Quiz Lesson", documentId: "" },
    },
    exam: {
      course: { title: "E2E Exam Course", slug: "e2e-exam-course", documentId: "" },
      lesson: { title: "E2E Exam Lesson", documentId: "" },
    },
    confirm: {
      course: { title: "E2E Confirm Course", slug: "e2e-confirm-course", documentId: "" },
      lesson: { title: "E2E Confirm Lesson", documentId: "" },
    },
  };
  assert.equal(
    new Set(Object.values(fixtures.users).map((user) => user.password)).size,
    Object.keys(fixtures.users).length,
    "Each fixture user needs a separate password",
  );

  const requireFromCms = createRequire(join(appDir, "package.json"));
  const { Client } = requireFromCms("pg");
  const db = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    application_name: runId,
    connectionTimeoutMillis: 5_000,
  });
  phase = "empty database check";
  try {
    await db.connect();
    const result = await db.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
    );
    assert.equal(
      result.rows[0].count,
      0,
      "Refusing to bootstrap a database that already contains tables",
    );
  } finally {
    await db.end();
  }

  phase = "CMS bootstrap";
  // Prevent Strapi's daily update lookup in this isolated test container.
  writeFileSync(
    join(appDir, ".strapi-updater.json"),
    JSON.stringify({ lastUpdateCheck: Date.now() }),
  );
  const { createStrapi } = requireFromCms("@strapi/strapi");
  /** @type {Cms} */
  const cms = createStrapi({
    appDir,
    distDir: join(appDir, "dist"),
    autoReload: false,
    serveAdminPanel: false,
  });
  strapi = cms;
  // createStrapi installs immediate shutdown handlers; finish in-flight startup first.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.removeAllListeners(signal);
    process.once(signal, () => {
      void stop();
    });
  }
  cms.log.level = "error";
  await cms.load();
  cms.cron.stop();
  // The specs sign in more often than the users-permissions throttle allows
  // (per IP). Off in this disposable container only, like the integration
  // harness; the plugin reads it per request.
  cms.config.set("plugin::users-permissions.ratelimit", { enabled: false });
  if (stopping) return;

  phase = "fixture creation";
  for (const uid of [userUid, departmentUid, teamUid, courseUid, lessonUid, progressUid]) {
    assert.equal(await cms.db.query(uid).count(), 0, `Unexpected bootstrap fixtures: ${uid}`);
  }
  const department = await cms.documents(departmentUid).create({
    data: { name: "E2E Department", slug: "e2e-department" },
  });
  const userService = cms.plugin("users-permissions").service("user");
  /** @param {string} key */
  const roleTypeOf = (key) =>
    key === "lead" ? "team_lead" : key === "admin" || key === "inviter" ? "admin_role" : key;
  for (const [key, fixture] of Object.entries(fixtures.users)) {
    const roleType = roleTypeOf(key);
    const role = await cms.db
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: roleType } });
    assert.ok(role, `Role missing after normal bootstrap: ${roleType}`);
    const user = await userService.add({
      username: `e2e-${key}`,
      email: fixture.email,
      displayName: `E2E ${key}`,
      provider: "local",
      password: fixture.password,
      confirmed: true,
      blocked: false,
      role: role.id,
      department: department.id,
    });
    fixture.documentId = user.documentId;
  }
  for (const [key, fixture] of Object.entries(fixtures.teams)) {
    const team = await cms.documents(teamUid).create({
      data: {
        name: fixture.name,
        slug: fixture.slug,
        description: fixture.description,
        department: department.documentId,
        ...(key === "editable" ? { lead: fixtures.users.lead.documentId } : {}),
        members:
          key === "editable"
            ? [fixtures.users.lead.documentId, fixtures.users.member.documentId]
            : [fixtures.users.member.documentId],
      },
    });
    fixture.documentId = team.documentId;
  }

  const quiz = [
    { question: "Which port is used for HTTPS?", options: ["80", "443"], correctIndex: 1 },
    { question: "Should you report a phishing email?", options: ["Yes", "No"], correctIndex: 0 },
  ];
  const trainingFixtures = [
    { fixture: fixtures.training, mode: "quizGate" },
    { fixture: fixtures.exam, mode: "exam" },
    { fixture: fixtures.confirm, mode: "confirm" },
  ];
  for (const { fixture, mode } of trainingFixtures) {
    const course = await cms.documents(courseUid).create({
      data: {
        title: fixture.course.title,
        slug: fixture.course.slug,
        mandatory: false,
        completionMode: mode,
      },
      status: "published",
    });
    fixture.course.documentId = course.documentId;
    const lesson = await cms.documents(lessonUid).create({
      data: {
        title: fixture.lesson.title,
        body: "Complete this security check before finishing the lesson.",
        order: 0,
        course: course.documentId,
        quiz,
      },
      status: "published",
    });
    fixture.lesson.documentId = lesson.documentId;
  }

  phase = "fixture relationship assertions";
  assert.equal(await cms.db.query(departmentUid).count(), 1, "Expected one department");
  assert.equal(await cms.db.query(userUid).count(), 5, "Expected five local users");
  assert.equal(await cms.db.query(teamUid).count(), 2, "Expected two teams");
  for (const [key, fixture] of Object.entries(fixtures.users)) {
    const user = await cms.db.query(userUid).findOne({
      where: { documentId: fixture.documentId },
      select: ["email", "provider", "confirmed", "blocked"],
      populate: {
        role: { select: ["type"] },
        department: { select: ["documentId"] },
        teams: { select: ["documentId"] },
      },
    });
    assert.ok(user, "Fixture user missing");
    assert.equal(user.email, fixture.email, "Fixture user email differs");
    assert.equal(user.provider, "local", "Fixture user must use local login");
    assert.equal(user.confirmed, true, "Fixture user must be confirmed");
    assert.equal(user.blocked, false, "Fixture user must not be blocked");
    assert.equal(user.role?.type, roleTypeOf(key), "Fixture user role differs");
    assert.equal(
      user.department?.documentId,
      department.documentId,
      "Fixture user department differs",
    );
    assert.ok(Array.isArray(user.teams), "Fixture user's team memberships are missing");
    const expectedTeams =
      key === "lead"
        ? [fixtures.teams.editable.documentId]
        : key === "member"
          ? Object.values(fixtures.teams).map((team) => team.documentId)
          : [];
    assert.deepEqual(
      new Set(user.teams.map((team) => team.documentId)),
      new Set(expectedTeams),
      "Fixture user team memberships differ",
    );
  }
  for (const [key, fixture] of Object.entries(fixtures.teams)) {
    const team = await cms.db.query(teamUid).findOne({
      where: { documentId: fixture.documentId },
      select: ["slug", "name", "description"],
      populate: {
        department: { select: ["documentId"] },
        lead: { select: ["documentId"] },
        members: { select: ["documentId"] },
      },
    });
    assert.ok(team, "Fixture team missing");
    assert.equal(team.slug, fixture.slug, "Fixture team slug differs");
    assert.equal(team.name, fixture.name, "Fixture team name differs");
    assert.equal(team.description, fixture.description, "Fixture team description differs");
    assert.equal(
      team.department?.documentId,
      department.documentId,
      "Fixture team department differs",
    );
    assert.equal(
      team.lead?.documentId ?? null,
      key === "editable" ? fixtures.users.lead.documentId : null,
      "Only the editable team may have the lead",
    );
    assert.ok(Array.isArray(team.members), "Fixture team members are missing");
    const expectedMembers =
      key === "editable"
        ? [fixtures.users.lead.documentId, fixtures.users.member.documentId]
        : [fixtures.users.member.documentId];
    assert.deepEqual(
      new Set(team.members.map((user) => user.documentId)),
      new Set(expectedMembers),
      "Fixture team members differ",
    );
  }
  assert.equal(
    new Set(trainingFixtures.map(({ fixture }) => fixture.course.documentId)).size,
    trainingFixtures.length,
    "Each quiz mode needs a separate course",
  );
  assert.equal(
    new Set(trainingFixtures.map(({ fixture }) => fixture.lesson.documentId)).size,
    trainingFixtures.length,
    "Each quiz mode needs a separate lesson",
  );
  for (const { fixture, mode } of trainingFixtures) {
    const publishedCourse = await cms.db.query(courseUid).findOne({
      where: { documentId: fixture.course.documentId, publishedAt: { $notNull: true } },
      select: ["title", "slug", "mandatory", "completionMode"],
    });
    assert.ok(publishedCourse, "Published fixture course missing");
    assert.equal(publishedCourse.title, fixture.course.title, "Fixture course title differs");
    assert.equal(publishedCourse.slug, fixture.course.slug, "Fixture course slug differs");
    assert.equal(publishedCourse.mandatory, false, "Fixture course must not be mandatory");
    assert.equal(publishedCourse.completionMode, mode, "Fixture course mode differs");
    const publishedLesson = await cms.db.query(lessonUid).findOne({
      where: { documentId: fixture.lesson.documentId, publishedAt: { $notNull: true } },
      select: ["title", "body", "order", "quiz"],
      populate: { course: { select: ["documentId", "publishedAt"] } },
    });
    assert.ok(publishedLesson, "Published fixture lesson missing");
    assert.equal(publishedLesson.title, fixture.lesson.title, "Fixture lesson title differs");
    assert.equal(
      publishedLesson.body,
      "Complete this security check before finishing the lesson.",
      "Fixture lesson body differs",
    );
    assert.equal(publishedLesson.order, 0, "Fixture lesson order differs");
    assert.equal(
      publishedLesson.course?.documentId,
      fixture.course.documentId,
      "Fixture lesson course differs",
    );
    assert.ok(
      publishedLesson.course?.publishedAt,
      "Fixture lesson must reference a published course",
    );
    assert.deepEqual(publishedLesson.quiz, quiz, "Fixture lesson quiz differs");
  }
  assert.equal(await cms.db.query(progressUid).count(), 0, "Fixture lessons must not be completed");
  if (stopping) return;
  writeFileSync(fixturePath, JSON.stringify(fixtures), { mode: 0o600, flag: "wx" });
  phase = "HTTP listener";
  await new Promise((resolve, reject) => {
    cms.server.httpServer.once("error", reject);
    cms.server.listen(1337, "0.0.0.0", () => {
      cms.server.httpServer.removeListener("error", reject);
      resolve(undefined);
    });
  });
  console.log(
    "[e2e-cms] Ready: normal bootstrap and fixture assertions passed (1 department, 5 users, 2 teams, 3 published quiz courses and lessons).",
  );
}

/** @param {number} [exitCode] */
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await started.catch(() => {
    exitCode = 1;
  });
  try {
    if (strapi) {
      // Document Service entry events re-read rows after commit without awaiting them.
      const pool = strapi.db?.connection?.client?.pool;
      let quiet = 0;
      for (let check = 0; pool && check < 400 && quiet < 3; check += 1) {
        await delay(25);
        quiet = pool.numUsed() === 0 && pool.numPendingAcquires() === 0 ? quiet + 1 : 0;
      }
      await strapi.destroy();
    }
  } catch {
    console.error("[e2e-cms] CMS shutdown failed.");
    exitCode = 1;
  }
  process.exit(exitCode);
}

const started = start();
try {
  await started;
} catch (error) {
  // Never print database errors, user-service input, or credential-bearing objects.
  const reason =
    error instanceof AssertionError
      ? error.message.split("\n")[0]
      : error instanceof Error
        ? error.name
        : "Unknown error";
  console.error(`[e2e-cms] Failed during ${phase}: ${reason}`);
  await stop(1);
}
