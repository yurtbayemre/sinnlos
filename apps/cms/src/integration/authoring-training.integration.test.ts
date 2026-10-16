import type { CourseEditable, LessonEditable, LessonAuthoringListRow } from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { authoringApi, storedRevision, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const PROGRESS = "api::lesson-progress.lesson-progress";
const QUIZ = [{ question: "Choose the second option?", options: ["No", "Yes"], correctIndex: 1 }];

interface Scheduler {
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<unknown>;
}

/** Real shared gate/controller, including draft/published privacy and nondeleting discard. */
describe.each(testEngines())("training authoring on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let panel: ContentManager;
  let serial = 0;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    api = authoringApi(t);
    panel = await contentManager(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const course = async (
    status: "draft" | "published" = "draft",
    role: "admin_role" | "editor" = "editor",
  ) => {
    const res = await api.create(
      role,
      "courses",
      { title: `Training ${++serial}`, completionMode: "exam" },
      status,
    );
    expect(res.status, res.text).toBe(201);
    return res.body.data;
  };
  const lesson = async (courseId: string, status: "draft" | "published" = "draft") => {
    const res = await api.create(
      "editor",
      "lessons",
      { title: `Lesson ${++serial}`, course: courseId, quiz: QUIZ, order: 3 },
      status,
    );
    expect(res.status, res.text).toBe(201);
    return res.body.data;
  };

  it.each(["admin_role", "editor"] as const)(
    "%s creates and edits training through fixed DTOs",
    async (role) => {
      const parent = await course("draft", role);
      const child = await lesson(parent.documentId);
      const form = await api.editable<CourseEditable>(role, "courses", parent.documentId);
      expect(form.status, form.text).toBe(200);
      expect(form.body.data).toMatchObject({
        completionMode: "exam",
        roleClass: "moderator",
        status: "draft",
        coverImage: null,
      });
      expect(form.body.data.slug).not.toBe("");
      expect(form.body.data).not.toHaveProperty("lessons");
      const childForm = await api.editable<LessonEditable>(role, "lessons", child.documentId);
      expect(childForm.status, childForm.text).toBe(200);
      expect(childForm.body.data).toMatchObject({
        quiz: QUIZ,
        order: 3,
        course: { documentId: parent.documentId, slug: form.body.data.slug },
      });
      expect(childForm.headers.get("etag")).toBe(`"${childForm.body.data.version}"`);
      const saved = await api.update(
        role,
        "lessons",
        child.documentId,
        { title: "Renamed", order: 4 },
        { version: child.version },
      );
      expect(saved.status, saved.text).toBe(200);
      expect(Number(saved.body.data.version)).toBe(Number(child.version) + 1);
      expect(saved.body.data).not.toHaveProperty("quiz");
    },
  );

  it.each(["department_head", "team_lead", "member", "guest", "authenticated"] as const)(
    "%s cannot author or read keys",
    async (role) => {
      const parent = await course();
      const child = await lesson(parent.documentId);
      for (const [plural, target] of [
        ["courses", parent],
        ["lessons", child],
      ] as const) {
        expect(
          (await api.create(role, plural, { title: "Denied", course: parent.documentId }, "draft"))
            .status,
        ).toBe(403);
        expect(
          (
            await api.update(
              role,
              plural,
              target.documentId,
              { title: "Denied" },
              { version: target.version },
            )
          ).status,
        ).toBe(403);
        expect((await api.list(role, plural)).status).toBe(403);
        expect((await api.editable(role, plural, target.documentId)).status).toBe(403);
        for (const action of ["publish", "unpublish", "discard-draft"] as const) {
          expect(
            (await api.action(role, plural, target.documentId, action, target.version)).status,
          ).toBe(403);
        }
      }
    },
  );

  it("requires explicit status and refuses structural, internal, inverse and unlisted fields", async () => {
    const parent = await course();
    for (const plural of ["courses", "lessons"]) {
      expect(
        (
          await api.create(
            "editor",
            plural,
            { title: "No status", course: parent.documentId },
            null,
          )
        ).status,
      ).toBe(400);
    }
    for (const [plural, data, key, code] of [
      ["courses", { slug: "forged" }, "slug", undefined],
      ["courses", { lessons: [] }, "lessons", undefined],
      ["courses", { scheduleError: "forged" }, "scheduleError", undefined],
      ["courses", { mandatory: "yes" }, "mandatory", "invalid"],
      ["courses", { completionMode: "other" }, "completionMode", "invalid"],
      ["lessons", { course: null }, "course", undefined],
      ["lessons", { course: "unknown" }, "course", undefined],
      ["lessons", { quiz: "[]" }, "quiz", "quizInvalid"],
      ["lessons", { quiz: [{ ...QUIZ[0], correctIndex: 7 }] }, "quiz", "quizInvalid"],
      ["lessons", { videoUrl: "https://vimeo.com/1" }, "videoUrl", "videoUrlNotYoutube"],
      ["lessons", { order: 10001 }, "order", "invalid"],
      ["lessons", { progress: [] }, "progress", undefined],
    ] as const) {
      const res = await api.create(
        "editor",
        plural,
        {
          title: "Invalid",
          ...(plural === "lessons" ? { course: parent.documentId } : {}),
          ...data,
        },
        "draft",
      );
      expect(res.status, res.text).toBe(400);
      expect(res.body.error?.details?.keys, res.text).toContain(key);
      if (code) expect(res.body.error?.details?.codes?.[key]).toBe(code);
    }
    expect((await api.create("editor", "lessons", { title: "No parent" }, "draft")).status).toBe(
      400,
    );
  });

  it("requires current If-Match, preserves numeric route compatibility and invalidates forms after panel saves", async () => {
    const parent = await course();
    const child = await lesson(parent.documentId);
    for (const [uid, plural, item] of [
      [COURSE, "courses", parent],
      [LESSON, "lessons", child],
    ] as const) {
      expect(
        (await api.update("editor", plural, item.documentId, { title: "No token" })).status,
      ).toBe(428);
      const saved = await panel.update(uid, item.documentId, { title: "Panel change" });
      expect(saved.status, saved.text).toBe(200);
      expect(
        (
          await api.update(
            "editor",
            plural,
            item.documentId,
            { title: "Stale" },
            { version: item.version },
          )
        ).status,
      ).toBe(412);
      const [row] = await t.strapi.db
        .query(uid)
        .findMany({ where: { documentId: item.documentId, publishedAt: null } });
      const form = await api.editable("editor", plural, String(row.id));
      expect(form.status, form.text).toBe(200);
      expect(form.body.data).toMatchObject({ documentId: item.documentId, title: "Panel change" });
      const updated = await api.update(
        "editor",
        plural,
        String(row.id),
        { title: "Numeric id save" },
        { version: form.body.data.version },
      );
      expect(updated.status, updated.text).toBe(200);
    }
  });

  it("filters lessons by canonical course before pagination and count, including draft parents", async () => {
    const target = await course();
    const other = await course();
    const first = await lesson(target.documentId);
    for (let i = 0; i < 26; i++) await lesson(other.documentId);
    const second = await lesson(target.documentId);
    const list = await api.list<LessonAuthoringListRow>(
      "editor",
      "lessons",
      `course=${target.documentId}`,
    );
    expect(list.status, list.text).toBe(200);
    expect(list.body.meta.pagination).toMatchObject({ total: 2, pageCount: 1 });
    expect(list.body.data.map((row) => row.documentId).sort()).toEqual(
      [first.documentId, second.documentId].sort(),
    );
    for (const row of list.body.data) {
      expect(row.course).toMatchObject({ documentId: target.documentId });
      expect(row.order).toBe(3);
      expect(row).not.toHaveProperty("quiz");
    }
    expect((await api.list("editor", "lessons", "course=1")).status).toBe(400);
    expect((await api.list("editor", "courses", `course=${target.documentId}`)).status).toBe(400);
    const moved = await api.update(
      "editor",
      "lessons",
      first.documentId,
      { course: { set: [other.documentId] } },
      { version: first.version },
    );
    expect(moved.status, moved.text).toBe(200);
    const after = await api.list<LessonAuthoringListRow>(
      "editor",
      "lessons",
      `course=${target.documentId}`,
    );
    expect(after.body.meta.pagination.total).toBe(1);
    expect(after.body.data[0].documentId).toBe(second.documentId);
  });

  it("never deletes draft-only or unpublished training through discard, preserving lesson links", async () => {
    for (const previouslyPublished of [false, true]) {
      const parent = await course(previouslyPublished ? "published" : "draft");
      const child = await lesson(parent.documentId, previouslyPublished ? "published" : "draft");
      for (const [uid, plural, item] of [
        [LESSON, "lessons", child],
        [COURSE, "courses", parent],
      ] as const) {
        let version = item.version;
        if (previouslyPublished) {
          const unpublish = await api.action(
            "editor",
            plural,
            item.documentId,
            "unpublish",
            version,
          );
          expect(unpublish.status, unpublish.text).toBe(200);
          version = unpublish.body.data.version;
        }
        const before = await storedRevision(t, uid, item.documentId);
        const discard = await api.action(
          "editor",
          plural,
          item.documentId,
          "discard-draft",
          version,
        );
        expect(discard.status, discard.text).toBe(400);
        expect(discard.body.error?.details).toMatchObject({
          keys: ["_form"],
          codes: { _form: "neverPublished" },
        });
        expect(await storedRevision(t, uid, item.documentId)).toBe(before);
        expect((await api.remove("admin_role", plural, item.documentId, version)).status).toBe(405);
      }
      const rows = await t.strapi.db.query(LESSON).findMany({
        where: { documentId: child.documentId },
        populate: { course: { select: ["documentId"] } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].course).toMatchObject({ documentId: parent.documentId });
      expect(
        await t.strapi.db.query(COURSE).count({ where: { documentId: parent.documentId } }),
      ).toBe(1);
    }
  });

  it("a draft quiz clear leaves the published quiz and progress intact, discard restores it, republish copies the clear", async () => {
    const parent = await course("published");
    const child = await lesson(parent.documentId, "published");
    const completed = await t.api("member", "/api/lesson-progresses", {
      json: { data: { targetDocumentId: child.documentId, answers: [1] } },
    });
    expect(completed.status, completed.text).toBe(200);
    const clear = await api.update(
      "editor",
      "lessons",
      child.documentId,
      { quiz: null },
      { version: child.version },
    );
    expect(clear.status, clear.text).toBe(200);
    const rows = await t.strapi.db
      .query(LESSON)
      .findMany({ where: { documentId: child.documentId } });
    expect(rows.find((row) => row.publishedAt == null)?.quiz).toBeNull();
    expect(rows.find((row) => row.publishedAt != null)?.quiz).toEqual(QUIZ);
    const discard = await api.action(
      "editor",
      "lessons",
      child.documentId,
      "discard-draft",
      clear.body.data.version,
    );
    expect(discard.status, discard.text).toBe(200);
    expect(
      (await api.editable<LessonEditable>("editor", "lessons", child.documentId)).body.data.quiz,
    ).toEqual(QUIZ);
    const again = await api.update(
      "editor",
      "lessons",
      child.documentId,
      { quiz: [] },
      { version: discard.body.data.version },
    );
    const publish = await api.action(
      "editor",
      "lessons",
      child.documentId,
      "publish",
      again.body.data.version,
    );
    expect(publish.status, publish.text).toBe(200);
    const published = await t.strapi
      .documents(LESSON)
      .findOne({ documentId: child.documentId, status: "published" });
    expect(published?.quiz).toEqual([]);
    expect(
      await t.strapi.db.query(PROGRESS).count({ where: { targetDocumentId: child.documentId } }),
    ).toBe(1);
    const generic = await t.api("editor", `/api/lessons/${child.documentId}?fields[0]=quiz`);
    expect(generic.text).not.toContain("correctIndex");
  });

  it("requires a published course through web, panel and scheduler; orphans can be repaired as drafts", async () => {
    const parent = await course();
    const child = await lesson(parent.documentId);
    const web = await api.action("editor", "lessons", child.documentId, "publish", child.version);
    expect(web.status, web.text).toBe(400);
    expect(web.body.error?.details?.codes).toMatchObject({ course: "notPublishable" });
    const panelPublish = await panel.publish(LESSON, child.documentId);
    expect(panelPublish.status, panelPublish.text).toBe(400);
    expect(panelPublish.body.error?.details?.codes).toEqual({ course: "notPublishable" });
    const parentPublish = await api.action(
      "editor",
      "courses",
      parent.documentId,
      "publish",
      parent.version,
    );
    expect(parentPublish.status, parentPublish.text).toBe(200);
    const form = await api.editable("editor", "lessons", child.documentId);
    const publishAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const scheduled = await api.update(
      "editor",
      "lessons",
      child.documentId,
      { publishAt },
      { version: form.body.data.version },
    );
    expect(scheduled.status, scheduled.text).toBe(200);
    await t.strapi.documents(COURSE).unpublish({ documentId: parent.documentId });
    await t
      .requireBuilt<Scheduler>("src/cron/scheduled-publish")
      .runScheduledPublishing(t.strapi, new Date(Date.now() + 10 * 60_000));
    const after = await api.editable<LessonEditable>("editor", "lessons", child.documentId);
    expect(after.body.data).toMatchObject({ status: "draft", scheduleError: "notPublishable" });
    const orphan = await t.strapi.documents(LESSON).create({ data: { title: "Orphan" } });
    const orphanForm = await api.editable<LessonEditable>("editor", "lessons", orphan.documentId);
    expect(orphanForm.body.data.course).toBeNull();
    const orphanPublish = await panel.publish(LESSON, orphan.documentId);
    expect(orphanPublish.status, orphanPublish.text).toBe(400);
    const repaired = await api.update(
      "editor",
      "lessons",
      orphan.documentId,
      { course: parent.documentId },
      { version: orphanForm.body.data.version },
    );
    expect(repaired.status, repaired.text).toBe(200);
  });

  it("panel JSON normalization preserves the lifecycle backstop and stable error codes", async () => {
    const parent = await course("published");
    const child = await lesson(parent.documentId);
    const edited = await panel.update(LESSON, child.documentId, { quiz: JSON.stringify(QUIZ) });
    expect(edited.status, edited.text).toBe(200);
    const invalid = await panel.update(LESSON, child.documentId, { quiz: "[{" });
    expect(invalid.status, invalid.text).toBe(400);
    expect(invalid.body.error?.details).toMatchObject({
      keys: ["quiz"],
      codes: { quiz: "quizInvalid" },
    });
    const published = await panel.publish(LESSON, child.documentId);
    expect(published.status, published.text).toBe(200);
    expect(
      (
        await t.strapi
          .documents(LESSON)
          .findOne({ documentId: child.documentId, status: "published" })
      )?.quiz,
    ).toEqual(QUIZ);
  });
});
