import { errors } from "@strapi/utils";
import { afterEach, describe, expect, it } from "vitest";

import {
  appContentType,
  openDocumentService,
  type OpenDocumentService,
  type TestRow,
} from "../test/document-service.test.helper";
import { createStrapiStub } from "../test/strapi-stub.test.helper";
import {
  NotPublishableError,
  READINESS_RELATIONS,
  createPublishReadiness,
  overlayDraft,
  publishBlockers,
  publishesInAction,
  type PublishReadinessHost,
} from "./publish-readiness";

/** Publish readiness (decision 06 §G2 row 4; contract K3). */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const LESSON = "api::lesson.lesson";
const COURSE = "api::course.course";
const WIKI_PAGE = "api::wiki-page.wiki-page";

describe("publishBlockers (K3)", () => {
  const stub = () => {
    const strapi = createStrapiStub();
    const draftCourse = strapi.seedDocument(COURSE, { title: "Draft course", slug: "draft" });
    const liveCourse = strapi.seedDocument(
      COURSE,
      { title: "Live course", slug: "live" },
      { status: "published" },
    );
    return { strapi: strapi as unknown as PublishReadinessHost, draftCourse, liveCourse };
  };

  it("names the required scalars that are null or missing (the published validation)", async () => {
    const { strapi } = stub();
    expect(await publishBlockers(strapi, ANNOUNCEMENT, { title: null, body: "b" })).toEqual([
      "title",
    ]);
    expect(await publishBlockers(strapi, ANNOUNCEMENT, { title: "T" })).toEqual([]);
    expect(await publishBlockers(strapi, EVENT, {})).toEqual(["start", "title"]);
    // An empty string passes Strapi's notNil, so it does not block here either.
    expect(await publishBlockers(strapi, ANNOUNCEMENT, { title: "" })).toEqual([]);
  });

  it("names a number below its min (lesson.order >= 0)", async () => {
    const { strapi } = stub();
    expect(await publishBlockers(strapi, LESSON, { title: "L", order: -1 })).toEqual(["order"]);
    expect(await publishBlockers(strapi, LESSON, { title: "L", order: 0 })).toEqual([]);
  });

  it("lesson.course must have a published row, in every shape a relation arrives in", async () => {
    const { strapi, draftCourse, liveCourse } = stub();
    const blocks = (course: unknown) => publishBlockers(strapi, LESSON, { title: "L", course });
    for (const course of [
      draftCourse.documentId,
      { documentId: draftCourse.documentId },
      { id: draftCourse.draft?.id },
      draftCourse.draft?.id,
      { set: [{ documentId: draftCourse.documentId }] },
      { connect: [{ documentId: liveCourse.documentId }, { documentId: draftCourse.documentId }] },
      [{ documentId: draftCourse.documentId }],
      "no-such-course",
    ]) {
      expect(await blocks(course), JSON.stringify(course)).toEqual(["course"]);
    }
    for (const course of [
      liveCourse.documentId,
      { documentId: liveCourse.documentId },
      { set: [{ documentId: liveCourse.documentId }] },
      null,
      undefined,
      [],
      { set: [] },
      { connect: [], disconnect: [] },
    ]) {
      expect(await blocks(course), JSON.stringify(course)).toEqual([]);
    }
  });

  it("checks lesson.course and wiki-page.parent only", () => {
    expect(READINESS_RELATIONS).toEqual({ [LESSON]: ["course"], [WIKI_PAGE]: ["parent"] });
  });

  it("an unknown type has nothing to block", async () => {
    const { strapi } = stub();
    expect(await publishBlockers(strapi, "api::nothing.nothing", { title: null })).toEqual([]);
  });

  it("NotPublishableError is a 400 ValidationError with keys and codes", () => {
    const error = new NotPublishableError(["title", "course", "title"]);
    expect(error).toBeInstanceOf(errors.ValidationError);
    expect(error).toMatchObject({
      name: "ValidationError",
      message: "This draft cannot be published yet: course, title",
      details: {
        keys: ["course", "title"],
        codes: { course: "notPublishable", title: "notPublishable" },
      },
    });
  });
});

describe("overlayDraft and publishesInAction", () => {
  it("overlays a payload; relation operations keep, replace or clear the stored target", () => {
    const stored = { title: "Old", course: { documentId: "c1" } };
    expect(overlayDraft(stored, { title: "New" })).toEqual({
      title: "New",
      course: { documentId: "c1" },
    });
    expect(overlayDraft(stored, { course: { connect: [], disconnect: [] } }).course).toEqual({
      documentId: "c1",
    });
    expect(overlayDraft(stored, { course: { connect: [{ documentId: "c2" }] } }).course).toEqual([
      { documentId: "c2" },
    ]);
    expect(
      overlayDraft(stored, { course: { disconnect: [{ documentId: "c1" }] } }).course,
    ).toBeNull();
    expect(overlayDraft(stored, { course: { set: [] } }).course).toEqual([]);
    expect(overlayDraft(stored, { course: null }).course).toBeNull();
    expect(overlayDraft(null, { title: "T" })).toEqual({ title: "T" });
  });

  it("publish, and create/update with status published, publish", () => {
    expect(publishesInAction("publish", {})).toBe(true);
    expect(publishesInAction("create", { status: "published" })).toBe(true);
    expect(publishesInAction("update", { status: "published" })).toBe(true);
    expect(publishesInAction("update", { status: "draft" })).toBe(false);
    expect(publishesInAction("update", {})).toBe(false);
    expect(publishesInAction("unpublish", {})).toBe(false);
    expect(publishesInAction("discardDraft", { status: "published" })).toBe(false);
  });
});

describe("the middleware on the real document service (C23)", () => {
  let open: OpenDocumentService;
  afterEach(async () => {
    await open?.close();
  });

  const keepRelations = (name: string, attribute: Record<string, unknown>) =>
    attribute.type !== "media" &&
    (attribute.type !== "relation" || ["course", "lessons"].includes(name));

  async function training() {
    open = await openDocumentService([
      appContentType(COURSE, keepRelations),
      appContentType(LESSON, keepRelations),
    ]);
    // The lock's transaction stand-in: everything a test does under it rolls back together.
    open.service.use(async (_context, next) => open.db.transaction(() => next()));
    open.service.use(createPublishReadiness(open.strapi as unknown as PublishReadinessHost));
    const lessons = open.service(LESSON);
    const courses = open.service(COURSE);
    return { lessons, courses };
  }

  const refusal = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

  const lessonRows = async (documentId: string) =>
    (await open.db.query(LESSON).findMany({
      where: { documentId },
      orderBy: { id: "asc" },
      populate: { course: { select: ["documentId"] } },
    })) as TestRow[];

  it("refuses to publish a lesson of a draft-only course; publishes once the course is live", async () => {
    const { lessons, courses } = await training();
    const course = await courses.create({ data: { title: "C", slug: "c" } });
    const lesson = await lessons.create({ data: { title: "L", course: course.documentId } });
    const error = await refusal(lessons.publish({ documentId: lesson.documentId }));
    expect(error).toBeInstanceOf(NotPublishableError);
    expect(error).toMatchObject({ details: { keys: ["course"] } });
    expect((await lessonRows(lesson.documentId)).map((row) => row.publishedAt)).toEqual([null]);

    await courses.publish({ documentId: course.documentId });
    await lessons.publish({ documentId: lesson.documentId });
    const [, published] = await lessonRows(lesson.documentId);
    expect(published.course).toMatchObject({ documentId: course.documentId });
  });

  it("refuses a draft without its required title", async () => {
    const { lessons } = await training();
    const lesson = await lessons.create({ data: { body: "no title yet" } });
    const error = await refusal(lessons.publish({ documentId: lesson.documentId }));
    expect(error).toMatchObject({ details: { keys: ["title"] } });
  });

  it("refuses a create or update with status published the same way, before writing", async () => {
    const { lessons, courses } = await training();
    const course = await courses.create({ data: { title: "C", slug: "c" } });
    const created = await refusal(
      lessons.create({ data: { title: "L", course: course.documentId }, status: "published" }),
    );
    expect(created).toBeInstanceOf(NotPublishableError);
    expect(await open.db.query(LESSON).count({})).toBe(0);

    const draft = await lessons.create({ data: { title: "L", course: course.documentId } });
    // The Content Manager sends an untouched relation as empty operations.
    const updated = await refusal(
      lessons.update({
        documentId: draft.documentId,
        data: { title: "L2", course: { connect: [], disconnect: [] } },
        status: "published",
      }),
    );
    expect(updated).toMatchObject({ details: { keys: ["course"] } });
    expect((await lessonRows(draft.documentId)).map((row) => row.title)).toEqual(["L"]);
  });

  it("refuses a publish that lost the link anyway (the course unpublished in between) and rolls it back", async () => {
    const { lessons, courses } = await training();
    const course = await courses.create({ data: { title: "C", slug: "c" }, status: "published" });
    const lesson = await lessons.create({ data: { title: "L", course: course.documentId } });
    // Inner to readiness: the course goes away after the check, before the copy.
    open.service.use(async (context, next) => {
      if (context.uid === LESSON && context.action === "publish") {
        await courses.unpublish({ documentId: course.documentId });
      }
      return next();
    });
    const error = await refusal(lessons.publish({ documentId: lesson.documentId }));
    expect(error).toMatchObject({ details: { keys: ["course"] } });
    expect((await lessonRows(lesson.documentId)).map((row) => row.publishedAt)).toEqual([null]);
    // The unpublish of the course rolled back with it.
    expect(await open.db.query(COURSE).count({ where: { publishedAt: { $notNull: true } } })).toBe(
      1,
    );
  });

  it("leaves unpublish, discard and non-scheduled types alone", async () => {
    const { lessons, courses } = await training();
    const course = await courses.create({ data: { title: "C", slug: "c" }, status: "published" });
    const lesson = await lessons.create({
      data: { title: "L", course: course.documentId },
      status: "published",
    });
    await expect(lessons.unpublish({ documentId: lesson.documentId })).resolves.toBeDefined();
    await expect(lessons.discardDraft({ documentId: lesson.documentId })).resolves.toBeDefined();
  });
});
