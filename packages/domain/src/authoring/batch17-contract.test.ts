import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ORG_AUTHORING_INTENTS,
  ORG_FIELDS,
  QUIZ_CONTENT_INVALID,
  TRAINING_AUTHORING_INTENTS,
  TRAINING_FIELDS,
  type ActivityListQuery,
  type ActivityListResponse,
  type CourseEditable,
  type DepartmentEditable,
  type LearnerQuizQuestion,
  type LessonAuthoringListQuery,
  type LessonAuthoringListResponse,
  type LessonCompletionRequest,
  type LessonEditable,
  type LessonPlayerResponse,
  type OrgEditableResponse,
  type OrgWriteQuery,
  type OrgWriteResponse,
  type QuizCheckRequest,
  type QuizCheckResponse,
  type TeamEditable,
  type TrainingAuthoringIntent,
  type TrainingWriteQuery,
} from "../index.js";

describe("batch 17 consumer contracts", () => {
  it("keeps one answerless learner shape and server-selected feedback for all modes", () => {
    const player: LessonPlayerResponse = {
      data: {
        documentId: "lesson-1",
        title: "Lesson",
        body: null,
        order: 0,
        videoUrl: null,
        course: { documentId: "course-1", title: "Course", slug: "course", completionMode: "exam" },
        quiz: [{ question: "Choose one", options: ["First", "Second"] }],
      },
    };
    const partial: QuizCheckRequest = {
      data: { answers: [{ questionIndex: 0, optionIndex: 1 }] },
    };
    const feedback: QuizCheckResponse = {
      data: {
        completionMode: "confirm",
        passed: false,
        verdicts: [{ questionIndex: 0, correct: false }],
      },
    };
    const exam: QuizCheckResponse = { data: { completionMode: "exam", passed: false } };
    const completion: LessonCompletionRequest = {
      data: { targetDocumentId: player.data.documentId, answers: [1] },
    };

    expect(Object.keys(player.data.quiz[0])).toEqual(["question", "options"]);
    expect(partial.data.answers[0].questionIndex).toBe(feedback.data.verdicts?.[0].questionIndex);
    expect(exam.data).not.toHaveProperty("verdicts");
    expect(completion.data).toEqual({ targetDocumentId: "lesson-1", answers: [1] });
    expect(QUIZ_CONTENT_INVALID).toBe("quizContentInvalid");
    // @ts-expect-error The author answer key is not part of the learner contract.
    expectTypeOf<LearnerQuizQuestion>().toHaveProperty("correctIndex");
    expectTypeOf<keyof QuizCheckRequest["data"]>().toEqualTypeOf<"answers">();
  });

  it("carries quiz keys only in author contracts and the lesson parent before pagination", () => {
    const course: CourseEditable = {
      documentId: "course-1",
      version: "4",
      status: "modified",
      publishedAt: "2026-10-16T08:00:00.000Z",
      updatedAt: "2026-10-16T09:00:00.000Z",
      roleClass: "moderator",
      title: "Course",
      slug: "course",
      description: null,
      mandatory: true,
      completionMode: "exam",
      validityMonths: 12,
      departments: [],
      needsRetarget: false,
      coverImage: null,
      publishAt: null,
      scheduleError: null,
    };
    const lesson: LessonEditable = {
      documentId: "lesson-1",
      version: "2",
      status: "draft",
      publishedAt: null,
      updatedAt: null,
      roleClass: "moderator",
      title: "Lesson",
      body: null,
      order: 3,
      course: { documentId: course.documentId, title: course.title, slug: course.slug },
      videoUrl: null,
      quiz: [{ question: "Choose one", options: ["First", "Second"], correctIndex: 1 }],
      publishAt: null,
      scheduleError: null,
    };
    const query: LessonAuthoringListQuery = { course: course.documentId, status: "draft", page: 1 };
    const list: LessonAuthoringListResponse = {
      data: [
        {
          documentId: lesson.documentId,
          label: lesson.title,
          version: lesson.version,
          status: lesson.status,
          publishedAt: null,
          updatedAt: null,
          authorName: null,
          needsRetarget: false,
          course: lesson.course,
          order: lesson.order,
        },
      ],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: 1 } },
    };

    expect(list.data[0].course?.documentId).toBe(query.course);
    expect(lesson.quiz[0].correctIndex).toBe(1);
    expect(TRAINING_FIELDS.lesson.moderator).toContain("course");
    expect(TRAINING_AUTHORING_INTENTS).not.toContain("delete");
    expectTypeOf<Extract<TrainingAuthoringIntent, "delete">>().toBeNever();
    expectTypeOf<TrainingWriteQuery>().toEqualTypeOf<{ status: "draft" | "published" }>();
  });

  it("gives organisation editors single-row responses and only their content fields", () => {
    const department: OrgEditableResponse<DepartmentEditable> = {
      data: {
        documentId: "department-1",
        version: "7",
        updatedAt: null,
        name: "Department",
        slug: "department",
        description: "<p>Legacy description</p>",
        color: "#6366f1",
        roleClass: "departmentHead",
      },
    };
    const team: OrgEditableResponse<TeamEditable> = {
      data: {
        documentId: "team-1",
        version: "9",
        updatedAt: null,
        name: "Team",
        slug: "team",
        description: "Team description",
        roleClass: "teamLead",
      },
    };
    const query: OrgWriteQuery = {};
    const saved: OrgWriteResponse = {
      data: { documentId: team.data.documentId, version: "10" },
    };

    expect(department.data.description).toBe("<p>Legacy description</p>");
    expect(saved.data.version).toBe("10");
    expect(query).toEqual({});
    expect(ORG_AUTHORING_INTENTS).toEqual(["update", "editable"]);
    expect(ORG_FIELDS.department.departmentHead).not.toContain("headerImage");
    expect(ORG_FIELDS.team.teamLead).toEqual(["description"]);
    expect(ORG_FIELDS.team.moderator).not.toContain("department");
    expectTypeOf<OrgWriteQuery["status"]>().toBeNever();
    // @ts-expect-error A single organisation row has no publication status.
    expectTypeOf<DepartmentEditable>().toHaveProperty("status");
    expectTypeOf<Extract<DepartmentEditable["roleClass"], "teamLead">>().toBeNever();
  });

  it("keeps user/admin identities scoped and includes system/file/classified activity", () => {
    const query: ActivityListQuery = {
      page: 1,
      targetUid: "plugin::upload.file",
      actorKind: "admin",
      actorId: 1,
      from: "2026-10-16T00:00:00+02:00",
      to: "2026-10-16T23:59:59+02:00",
    };
    const events: ActivityListResponse = {
      data: [
        {
          id: 3,
          createdAt: "2026-10-16T10:00:00.000Z",
          action: "delete",
          targetUid: "plugin::upload.file",
          targetDocumentId: "file-9",
          revision: null,
          source: "admin",
          keys: [],
          detail: null,
          actor: { kind: "admin", id: 1, displayName: "Deleted administrator #1", class: null },
        },
        {
          id: 2,
          createdAt: "2026-10-16T10:00:00.000Z",
          action: "delete",
          targetUid: "api::classified.classified",
          targetDocumentId: "classified-1",
          revision: null,
          source: "content-api",
          keys: [],
          detail: null,
          actor: { kind: "user", id: 1, displayName: "Member", class: "author" },
        },
        {
          id: 1,
          createdAt: "2026-10-16T10:00:00.000Z",
          action: "update",
          targetUid: "api::department.department",
          targetDocumentId: "department-1",
          revision: 1,
          source: "system",
          keys: ["description"],
          detail: null,
          actor: { kind: "system", id: null, displayName: "System", class: null },
        },
      ],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: 3 } },
    };

    expect(events.data[0].actor.kind).toBe(query.actorKind);
    expect(events.data[0].actor.id).toBe(events.data[1].actor.id);
    expectTypeOf<keyof ActivityListResponse["data"][number]["actor"]>().toEqualTypeOf<
      "kind" | "id" | "displayName" | "class"
    >();
  });
});
