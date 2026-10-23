import { randomBytes } from "node:crypto";
import type {
  AnonymisePreviewResponse,
  AnonymiseResponse,
  LessonPlayerResponse,
  TrainingEvidenceResponse,
  TrainingReportCourseResponse,
  UserExport,
} from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";
import { holdTransaction, qualified, settle, waitForLockWait } from "./pg-lock.test.helper";

/**
 * v0.28 lane A2 end to end (deep-dive plan-v028-rev2.md §2-§4 with rev3 and
 * rev3.1): the version token and the receipt snapshot, the export, the
 * anonymisation with its refusals and tombstone, the leavers report and the
 * per-person evidence, the retention job and the erasure sweep, and (on
 * Postgres) a profile write racing the block.
 */

const USER = "plugin::users-permissions.user";
const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const PROGRESS = "api::lesson-progress.lesson-progress";
const NOTIFICATION = "api::notification.notification";
const AUDIT = "api::audit-event.audit-event";
const CLASSIFIED = "api::classified.classified";
const FILE = "plugin::upload.file";

interface Person {
  id: number;
  documentId: string;
  username: string;
  password: string;
}

/** A success body, or Strapi's error envelope with its details code. */
type Answer<T> = T & {
  error?: { status?: number; name?: string; message?: string; details?: { code?: string } };
};

interface TrainingEvidence {
  pruneTrainingEvidence(
    strapi: unknown,
    env?: Record<string, string | undefined>,
    now?: Date,
  ): Promise<{ filled: number; deleted: number }>;
  fillMissingSnapshots(strapi: unknown, options?: Row): Promise<number>;
}
interface Anonymise {
  sweepAnonymised(strapi: unknown): Promise<{ deleted: number; rewritten: number }>;
}

describe.each(testEngines())("data protection (v0.28, lane A2) on %s", (engine) => {
  let t: TestStrapi;
  let course: Row;
  let lesson: Row;
  let suffix = 0;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    course = await t.strapi.documents(COURSE).create({
      data: { title: "Brandschutz", slug: "it-brandschutz", validityMonths: 12, mandatory: true },
      status: "published",
    });
    lesson = await t.strapi.documents(LESSON).create({
      data: { title: "Fluchtwege", course: course.documentId },
      status: "published",
    });
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** A fresh member account (the fixtures stay untouched for the other cases). */
  async function person(name: string): Promise<Person> {
    const role = (await t.strapi.db
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: "member" } })) as Row;
    const username = `it-dp-${++suffix}`;
    const password = randomBytes(12).toString("base64url");
    const service = t.strapi.plugin("users-permissions").service("user") as {
      add(data: Record<string, unknown>): Promise<Row>;
    };
    const user = await service.add({
      username,
      email: `${username}@integration.test`,
      displayName: name,
      provider: "local",
      password,
      confirmed: true,
      blocked: false,
      role: role.id,
      phone: "+49 30 1234",
      jobTitle: "Lagerist",
    });
    return { id: user.id as number, documentId: user.documentId as string, username, password };
  }

  const row = async (id: number) =>
    (await t.strapi.db.query(USER).findOne({ where: { id } })) as Row;
  const block = (id: number) =>
    t.api("admin_role", `/api/user-management/${id}`, {
      method: "PUT",
      json: { data: { blocked: true } },
    });
  const anonymise = (id: number, confirm: unknown) =>
    t.api<Answer<AnonymiseResponse>>("admin_role", `/api/user-management/${id}/anonymise`, {
      json: { data: { confirm } },
    });

  async function complete(jwt: string, version?: unknown) {
    return t.api<Answer<{ data?: Row }>>({ jwt }, "/api/lesson-progresses", {
      json: {
        data: {
          targetDocumentId: lesson.documentId,
          ...(version === undefined ? {} : { version }),
        },
      },
    });
  }

  it("binds the completion to the player's version and stores the snapshot", async () => {
    const ada = await person("Ada Lovelace");
    const jwt = await t.login(ada.username, ada.password);
    const player = await t.api<LessonPlayerResponse>(
      { jwt },
      `/api/lessons/${lesson.documentId}/player`,
    );
    expect(player.status, player.text).toBe(200);
    const version = player.body.data.version;
    expect(version).toEqual({ course: expect.any(String), lesson: expect.any(String) });

    const without = await complete(jwt);
    expect([without.status, without.body.error?.details?.code]).toEqual([409, "changed"]);

    // An author publishes the lesson again: the old version is refused.
    await t.strapi.documents(LESSON).update({
      documentId: lesson.documentId as string,
      data: { title: "Fluchtwege (neu)" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.strapi.documents(LESSON).publish({ documentId: lesson.documentId as string });
    const stale = await complete(jwt, version);
    expect([stale.status, stale.body.error?.details?.code]).toEqual([409, "changed"]);
    expect(await t.strapi.db.query(PROGRESS).count({ where: { user: { id: ada.id } } })).toBe(0);

    const fresh = (
      await t.api<LessonPlayerResponse>({ jwt }, `/api/lessons/${lesson.documentId}/player`)
    ).body.data.version;
    expect(fresh.lesson).not.toBe(version.lesson);
    const done = await complete(jwt, fresh);
    expect(done.status, done.text).toBe(200);
    expect(done.text).not.toContain("snapshot");
    const receipt = (await t.strapi.db
      .query(PROGRESS)
      .findOne({ where: { user: { id: ada.id } } })) as Row;
    expect(receipt.snapshot).toMatchObject({
      v: 1,
      course: { documentId: course.documentId, title: "Brandschutz", publishedAt: fresh.course },
      lesson: { title: "Fluchtwege (neu)", publishedAt: fresh.lesson },
      quizPassed: null,
      validUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      learner: { displayName: "Ada Lovelace", email: `${ada.username}@integration.test` },
    });
  });

  it("anonymises a blocked person in one run, refuses everything else, and keeps the evidence", async () => {
    const bob = await person("Bob Builder");
    const member = t.fixtures.users.member;
    // The person's data, through the query layer (the shapes the routes write).
    await t.strapi.db.query("api::reaction.reaction").create({
      data: {
        emoji: "thumbsup",
        targetType: "announcement",
        targetDocumentId: "x".repeat(24),
        author: bob.id,
      },
    });
    await t.strapi.db.query("api::kudos.kudos").create({
      data: { message: "Danke!", value: "teamwork", from: member.id, to: bob.id },
    });
    await t.strapi.db.query("api::kudos.kudos").create({
      data: { message: "Gern", value: "teamwork", from: bob.id, to: member.id },
    });
    await t.strapi.db.query("api::acknowledgement.acknowledgement").create({
      data: {
        user: bob.id,
        targetType: "announcement",
        targetDocumentId: "a".repeat(24),
        acknowledgedAt: new Date().toISOString(),
      },
    });
    await t.strapi.db.query(NOTIFICATION).create({
      data: { type: "kudos", title: "x", titleParams: {}, link: "/kudos", recipient: bob.id },
    });
    const naming = (await t.strapi.db.query(NOTIFICATION).create({
      data: {
        type: "comment",
        title: 'Bob Builder commented on "Plan"',
        titleParams: { actor: "Bob Builder", subject: "Plan" },
        link: "/announcements/x",
        recipient: member.id,
        actor: bob.id,
        sourceType: "announcement",
        sourceDocumentId: "b".repeat(24),
      },
    })) as Row;
    const announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "Bobs Beitrag", body: "Text", author: bob.documentId },
      status: "published",
    });
    // A receipt from before v0.28: no snapshot yet.
    await t.strapi.db.query(PROGRESS).create({
      data: {
        user: bob.id,
        targetDocumentId: lesson.documentId,
        completedAt: "2026-01-05T10:00:00.000Z",
      },
    });

    const preview = await t.api<Answer<AnonymisePreviewResponse>>(
      "admin_role",
      `/api/user-management/${bob.id}/anonymise`,
    );
    expect(preview.status, preview.text).toBe(200);
    expect(preview.body.data).toMatchObject({ blocked: false, anonymisedAt: null });
    expect(preview.body.data.counts).toMatchObject({
      deleted: { reactions: 1, kudosReceived: 1, acknowledgements: 1 },
      kept: { announcements: 1, kudosGiven: 1, trainingReceipts: 1 },
    });
    // The kudos lifecycle notifies too (after its commit), so at least these.
    expect(preview.body.data.counts.deleted.notifications).toBeGreaterThanOrEqual(1);
    expect(preview.body.data.counts.rewritten.notifications).toBeGreaterThanOrEqual(1);

    // Only admin_role, only after the block, only with the username.
    for (const caller of ["editor", "member", null] as const) {
      expect([401, 403]).toContain(
        (
          await t.api(caller, `/api/user-management/${bob.id}/anonymise`, {
            json: { data: { confirm: bob.username } },
          })
        ).status,
      );
    }
    const unblocked = await anonymise(bob.id, bob.username);
    expect([unblocked.status, unblocked.body.error?.details?.code]).toEqual([409, "notBlocked"]);
    expect((await block(bob.id)).status).toBe(200);
    const wrong = await anonymise(bob.id, "someone-else");
    expect([wrong.status, wrong.body.error?.details?.code]).toEqual([400, "confirm"]);
    expect((await row(bob.id)).anonymisedAt).toBeNull();

    const run = await anonymise(bob.id, bob.username);
    expect(run.status, run.text).toBe(200);
    expect(run.body.data.counts.deleted).toMatchObject({
      reactions: 1,
      kudosReceived: 1,
      acknowledgements: 1,
    });
    expect(run.body.data.counts.deleted.notifications).toBeGreaterThanOrEqual(1);
    expect(run.body.data.counts.rewritten.notifications).toBeGreaterThanOrEqual(1);
    expect(
      await t.strapi.db.query(NOTIFICATION).count({ where: { recipient: { id: bob.id } } }),
    ).toBe(0);
    expect(await t.strapi.db.query(NOTIFICATION).count({ where: { actor: { id: bob.id } } })).toBe(
      0,
    );
    expect(run.body.data.avatar).toBeNull();

    const tomb = await row(bob.id);
    expect(tomb).toMatchObject({
      username: `former-${bob.documentId}`,
      email: `former-${bob.documentId}@anonymised.invalid`,
      displayName: "Former person",
      phone: null,
      jobTitle: null,
      blocked: true,
      anonymisedAt: expect.anything(),
    });
    expect(tomb.password ?? null).toBeNull();
    expect(
      await t.strapi.db
        .query("api::reaction.reaction")
        .count({ where: { author: { id: bob.id } } }),
    ).toBe(0);
    expect(
      await t.strapi.db.query("api::kudos.kudos").count({ where: { to: { id: bob.id } } }),
    ).toBe(0);
    // Business content and the kudos they gave stay, with the neutral name.
    expect(
      await t.strapi.db.query("api::kudos.kudos").count({ where: { from: { id: bob.id } } }),
    ).toBe(1);
    const kept = (await t.strapi.db.query("api::announcement.announcement").findOne({
      where: { documentId: announcement.documentId },
      populate: { author: { select: ["displayName"] } },
    })) as Row;
    expect(kept.author).toMatchObject({ displayName: "Former person" });
    // The other person's notification keeps its meaning, without the name.
    const rewritten = (await t.strapi.db.query(NOTIFICATION).findOne({
      where: { id: naming.id },
      populate: { actor: true, recipient: { select: ["id"] } },
    })) as Row;
    expect(rewritten).toMatchObject({
      title: 'Someone commented on "Plan"',
      titleParams: { subject: "Plan" },
      actor: null,
      recipient: { id: member.id },
      sourceDocumentId: "b".repeat(24),
    });
    // The old receipt got its snapshot (backfilled) before the name went.
    const receipt = (await t.strapi.db
      .query(PROGRESS)
      .findOne({ where: { user: { id: bob.id } } })) as Row;
    expect(receipt.snapshot).toMatchObject({
      backfilled: true,
      learner: { displayName: "Bob Builder" },
    });
    const audit = (await t.strapi.db.query(AUDIT).findMany({
      where: { action: "anonymise", targetDocumentId: bob.documentId },
    })) as Row[];
    expect(audit).toHaveLength(1);
    expect(String(audit[0].detail)).not.toContain("Bob");

    // A second run, the user administration and the Content Manager leave the tombstone alone.
    const again = await anonymise(bob.id, `former-${bob.documentId}`);
    expect([again.status, again.body.error?.details?.code]).toEqual([409, "anonymised"]);
    const unblock = await t.api<Answer<unknown>>("admin_role", `/api/user-management/${bob.id}`, {
      method: "PUT",
      json: { data: { blocked: false } },
    });
    expect(unblock.status).toBe(400);
    expect(unblock.text).toContain("anonymised");
    await expect(
      t.strapi.documents(USER).update({ documentId: bob.documentId, data: { blocked: false } }),
    ).rejects.toThrow("anonymised");
    await expect(t.strapi.documents(USER).delete({ documentId: bob.documentId })).rejects.toThrow(
      "anonymised",
    );
    expect((await row(bob.id)).blocked).toBe(true);

    // People who left: admin_role sees them in the course report, named from the snapshot.
    const report = await t.api<Answer<TrainingReportCourseResponse>>(
      "admin_role",
      `/api/courses/${course.documentId}/report?leavers=1`,
    );
    expect(report.status, report.text).toBe(200);
    expect(report.body.data.leavers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: bob.id, name: "Bob Builder", left: "anonymised" }),
      ]),
    );
    expect(report.body.data.people.map((p) => p.userId)).not.toContain(bob.id);
    expect(
      (await t.api("department_head", `/api/courses/${course.documentId}/report?leavers=1`)).status,
    ).toBe(403);
    expect(
      (await t.api("admin_role", `/api/courses/${course.documentId}/report?leavers=0`)).status,
    ).toBe(400);
    const plain = await t.api<TrainingReportCourseResponse>(
      "admin_role",
      `/api/courses/${course.documentId}/report`,
    );
    expect(plain.body.data.leavers).toBeUndefined();

    const evidence = await t.api<Answer<TrainingEvidenceResponse>>(
      "admin_role",
      `/api/user-management/${bob.id}/training-evidence`,
    );
    expect(evidence.status, evidence.text).toBe(200);
    expect(evidence.body.data.rows).toEqual([
      expect.objectContaining({
        course: { documentId: course.documentId, title: "Brandschutz" },
        quiz: "unknown",
        validity: "unknown",
        backfilled: true,
        current: true,
      }),
    ]);
    expect((await t.api("member", `/api/user-management/${bob.id}/training-evidence`)).status).toBe(
      403,
    );
  });

  it("exports one person's data without a secret, and records it", async () => {
    const cleo = await person("Cleo Export");
    await t.strapi.db.query("api::comment.comment").create({
      data: {
        body: "Mein Kommentar",
        targetType: "announcement",
        targetDocumentId: "c".repeat(24),
        author: cleo.id,
      },
    });
    const res = await t.api<Answer<UserExport>>(
      "admin_role",
      `/api/user-management/${cleo.id}/export`,
    );
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body.account).toMatchObject({
      id: cleo.id,
      username: cleo.username,
      displayName: "Cleo Export",
      jobTitle: "Lagerist",
    });
    expect(res.body.content.comments).toEqual([
      expect.objectContaining({ body: "Mein Kommentar" }),
    ]);
    expect(Object.keys(res.body.content)).toEqual(
      expect.arrayContaining(["trainingReceipts", "pollVotes", "dutyShifts", "uploads"]),
    );
    expect(res.body.notIncluded.length).toBeGreaterThan(0);
    const hash = String(
      (
        (await t.strapi.db
          .query(USER)
          .findOne({ where: { id: cleo.id }, select: ["password"] })) as Row
      ).password,
    );
    expect(res.text).not.toContain(hash);
    for (const secret of ["tokenVersion", "totpSecret", "resetPasswordToken"])
      expect(res.text).not.toContain(secret);
    expect(
      await t.strapi.db
        .query(AUDIT)
        .count({ where: { action: "export", targetDocumentId: cleo.documentId } }),
    ).toBe(1);
    for (const caller of ["editor", "member", null] as const) {
      expect([401, 403]).toContain(
        (await t.api(caller, `/api/user-management/${cleo.id}/export`)).status,
      );
    }
  });

  it("the erasure sweep removes what reached an anonymised person after the run", async () => {
    const dora = await person("Dora Late");
    const member = t.fixtures.users.member;
    expect((await block(dora.id)).status).toBe(200);
    expect((await anonymise(dora.id, dora.username)).status).toBe(200);
    // A comment callback that read the name before the run and wrote after it.
    await t.strapi.db.query(NOTIFICATION).create({
      data: {
        type: "comment",
        title: 'Dora Late commented on "Plan"',
        titleParams: { actor: "Dora Late", subject: "Plan" },
        link: "/x",
        recipient: member.id,
        actor: dora.id,
      },
    });
    await t.strapi.db.query(NOTIFICATION).create({
      data: { type: "kudos", title: "x", titleParams: {}, link: "/kudos", recipient: dora.id },
    });
    const sweep = await t.requireBuilt<Anonymise>("src/utils/anonymise").sweepAnonymised(t.strapi);
    expect(sweep.deleted).toBeGreaterThanOrEqual(1);
    expect(sweep.rewritten).toBeGreaterThanOrEqual(1);
    expect(
      await t.strapi.db.query(NOTIFICATION).count({ where: { recipient: { id: dora.id } } }),
    ).toBe(0);
    expect(await t.strapi.db.query(NOTIFICATION).count({ where: { actor: { id: dora.id } } })).toBe(
      0,
    );
    const left = (await t.strapi.db
      .query(NOTIFICATION)
      .findMany({ where: { recipient: { id: member.id }, link: "/x" } })) as Row[];
    expect(left.map((n) => n.title)).toEqual(['Someone commented on "Plan"']);
  });

  it("the erasure sweep removes an ad that committed after the run, its photo after the commit", async () => {
    const fritz = await person("Fritz Late");
    expect((await block(fritz.id)).status).toBe(200);
    expect((await anonymise(fritz.id, fritz.username)).status).toBe(200);
    // An ad create authenticated before the block that committed after the
    // run (whole-release Codex review), with its stamped marketplace photo.
    const photo = (await t.strapi.db.query(FILE).create({
      data: {
        name: "late.png",
        hash: `it_dp_late_${engine}`,
        ext: ".png",
        mime: "image/png",
        size: 1,
        url: `/uploads/it_dp_late_${engine}.png`,
        provider: "local",
        provider_metadata: { uploadedBy: fritz.id },
      },
    })) as Row;
    const ad = (await t.strapi.documents(CLASSIFIED).create({
      data: {
        title: "IT late ad",
        description: "written after the anonymisation",
        category: "sale",
        expiresAt: "2099-12-31",
        author: fritz.id,
        images: [photo.id],
      },
    })) as Row;
    const sweep = await t.requireBuilt<Anonymise>("src/utils/anonymise").sweepAnonymised(t.strapi);
    expect(sweep.deleted).toBeGreaterThanOrEqual(1);
    expect(
      await t.strapi.db.query(CLASSIFIED).count({ where: { documentId: ad.documentId } }),
    ).toBe(0);
    // The classified lifecycle removes the image after the delete's commit.
    await expect
      .poll(async () => t.strapi.db.query(FILE).count({ where: { id: photo.id } }), {
        timeout: 10_000,
      })
      .toBe(0);
    // Recorded like the classified-janitor's deletes.
    expect(
      await t.strapi.db.query(AUDIT).count({
        where: { action: "delete", targetDocumentId: ad.documentId, source: "cron" },
      }),
    ).toBe(1);
  });

  it("the evidence job keeps current proof, deletes past retention, and fills missing snapshots", async () => {
    const eve = await person("Eve Retention");
    const evidence = t.requireBuilt<TrainingEvidence>("src/utils/training-evidence");
    const known = (validUntil: string | null, completedAt: string) => ({
      user: eve.id,
      targetDocumentId: lesson.documentId,
      completedAt,
      snapshot: {
        v: 1,
        course: null,
        lesson: null,
        completionMode: "confirm",
        quizPassed: null,
        validUntil,
        learner: { displayName: "Eve Retention", email: null },
      },
    });
    const old = (await t.strapi.db
      .query(PROGRESS)
      .create({ data: known("2021-01-10", "2020-01-10T10:00:00.000Z") })) as Row;
    const current = (await t.strapi.db
      .query(PROGRESS)
      .create({ data: known("2027-01-10", "2026-01-10T10:00:00.000Z") })) as Row;
    const now = new Date("2026-10-23T12:00:00.000Z");
    const result = await evidence.pruneTrainingEvidence(t.strapi, {}, now);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const ids = (
      (await t.strapi.db
        .query(PROGRESS)
        .findMany({ where: { user: { id: eve.id } }, select: ["id"] })) as Row[]
    ).map((r) => r.id);
    expect(ids).toEqual([current.id]);
    expect(ids).not.toContain(old.id);
    // Nothing is left without a snapshot (the nightly fill ran first).
    expect(await t.strapi.db.query(PROGRESS).count({ where: { snapshot: { $null: true } } })).toBe(
      0,
    );
  });

  it.runIf(engine === "postgres")(
    "a profile write that waits for the row behind a block writes nothing",
    async () => {
      const finn = await person("Finn Race");
      const jwt = await t.login(finn.username, finn.password);
      const held = await holdTransaction(t);
      await held.raw(`SELECT 1 FROM ${qualified(t, "up_users")} WHERE id = ? FOR UPDATE`, [
        finn.id,
      ]);
      const put = settle(
        t.api({ jwt }, "/api/me", { method: "PUT", json: { data: { jobTitle: "Restored" } } }),
      );
      await waitForLockWait(t);
      await held.raw(`UPDATE ${qualified(t, "up_users")} SET blocked = true WHERE id = ?`, [
        finn.id,
      ]);
      await held.commit();
      const outcome = await put;
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.status).toBe(401);
      expect((await row(finn.id)).jobTitle).toBe("Lagerist");
    },
    60_000,
  );

  it.runIf(engine === "postgres")(
    "a Content Manager save that waited behind an anonymisation is refused",
    async () => {
      const gus = await person("Gus Panel");
      const held = await holdTransaction(t);
      await held.raw(`SELECT 1 FROM ${qualified(t, "up_users")} WHERE id = ? FOR UPDATE`, [gus.id]);
      const save = settle(
        t.strapi
          .documents(USER)
          .update({ documentId: gus.documentId, data: { displayName: "Gus Restored" } }),
      );
      await waitForLockWait(t);
      await held.raw(
        `UPDATE ${qualified(t, "up_users")} SET blocked = true, anonymised_at = now(), display_name = 'Former person' WHERE id = ?`,
        [gus.id],
      );
      await held.commit();
      const outcome = await save;
      expect(outcome.ok).toBe(false);
      expect(String((outcome as { error?: unknown }).error)).toContain("anonymised");
      expect((await row(gus.id)).displayName).toBe("Former person");
    },
    60_000,
  );

  it.runIf(engine === "postgres")(
    "the evidence job waits for a running anonymisation and applies its later deadline",
    async () => {
      const hal = await person("Hal Evidence");
      const evidence = t.requireBuilt<TrainingEvidence>("src/utils/training-evidence");
      const receipt = (validUntil: string, completedAt: string) => ({
        user: hal.id,
        targetDocumentId: lesson.documentId,
        completedAt,
        snapshot: {
          v: 1,
          course: null,
          lesson: null,
          completionMode: "confirm",
          quizPassed: null,
          validUntil,
          learner: { displayName: "Hal Evidence", email: null },
        },
      });
      // Superseded and past its deadline for an active person (2021-01-10 + 3 years).
      await t.strapi.db
        .query(PROGRESS)
        .create({ data: receipt("2021-01-10", "2020-01-10T10:00:00.000Z") });
      await t.strapi.db
        .query(PROGRESS)
        .create({ data: receipt("2027-01-10", "2026-01-10T10:00:00.000Z") });
      const held = await holdTransaction(t);
      await held.raw(`SELECT 1 FROM ${qualified(t, "up_users")} WHERE id = ? FOR UPDATE`, [hal.id]);
      const job = settle(
        evidence.pruneTrainingEvidence(t.strapi, {}, new Date("2026-10-23T12:00:00.000Z")),
      );
      await waitForLockWait(t);
      await held.raw(
        `UPDATE ${qualified(t, "up_users")} SET blocked = true, anonymised_at = ? WHERE id = ?`,
        ["2026-10-22T10:00:00.000Z", hal.id],
      );
      await held.commit();
      expect((await job).ok).toBe(true);
      // Anonymised: max(2021-01-10, 2026-10-22) + 3 years lies ahead, both stay.
      expect(await t.strapi.db.query(PROGRESS).count({ where: { user: { id: hal.id } } })).toBe(2);
    },
    60_000,
  );
});
