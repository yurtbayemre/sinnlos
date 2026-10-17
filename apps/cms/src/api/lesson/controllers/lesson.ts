import { factories } from "@strapi/strapi";
import { QUIZ_CONTENT_INVALID, type LessonPlayerResponse } from "@sinnlos/domain";

import { loadPublishedLesson } from "../../../utils/training-access";
import { checkStoredQuiz, validateStoredQuiz } from "../../../utils/training-validation";

export default factories.createCoreController("api::lesson.lesson", ({ strapi }) => ({
  async player(ctx) {
    if (!ctx.state.user) return ctx.unauthorized();
    if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest("Query parameters not allowed");
    ctx.set("Cache-Control", "private, no-store");
    const lesson = await loadPublishedLesson(strapi, ctx.params.id);
    if (!lesson) return ctx.notFound("Lesson not available");
    const validated = validateStoredQuiz(lesson.quiz);
    if ("error" in validated) {
      return ctx.badRequest("Invalid quiz content", { code: QUIZ_CONTENT_INVALID });
    }
    const response: LessonPlayerResponse = {
      data: {
        documentId: lesson.documentId,
        title: lesson.title,
        body: lesson.body,
        order: lesson.order,
        videoUrl: lesson.videoUrl,
        course: {
          documentId: lesson.course.documentId,
          title: lesson.course.title,
          slug: lesson.course.slug,
          completionMode: lesson.course.completionMode ?? "confirm",
        },
        quiz: validated.quiz.map(({ question, options }) => ({ question, options })),
      },
    };
    return ctx.send(response);
  },

  async check(ctx) {
    if (!ctx.state.user) return ctx.unauthorized();
    if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest("Query parameters not allowed");
    ctx.set("Cache-Control", "private, no-store");
    const body = ctx.request.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !body.data ||
      typeof body.data !== "object" ||
      Array.isArray(body.data) ||
      Object.keys(body.data).length !== 1 ||
      !("answers" in body.data)
    )
      return ctx.badRequest("Expected data.answers only");
    const lesson = await loadPublishedLesson(strapi, ctx.params.id);
    if (!lesson) return ctx.notFound("Lesson not available");
    const result = checkStoredQuiz(
      lesson.quiz,
      lesson.course.completionMode ?? "confirm",
      body.data.answers,
    );
    if ("error" in result) {
      return result.error === QUIZ_CONTENT_INVALID
        ? ctx.badRequest("Invalid quiz content", { code: QUIZ_CONTENT_INVALID })
        : ctx.badRequest(result.error);
    }
    return ctx.send(result);
  },
}));
