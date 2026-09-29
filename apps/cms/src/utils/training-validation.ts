/**
 * Server-side validation for admin-authored training content (issue
 * #29) — pure and unit tested, consumed by the lesson lifecycles.
 *
 * WHY LIFECYCLES NEED THIS: admin-panel writes bypass every content-api
 * controller override, and until this module the repo had NO validation
 * that applies to admin writes at all (quick-link.url is still unvalidated
 * for exactly that reason; poll.options has its own validating lifecycle
 * since FX20, 2026-09-28). The lesson lifecycle is the repo's first
 * validating beforeCreate/beforeUpdate.
 *
 * The YouTube parser and the quiz schema live in @sinnlos/domain (SH01,
 * packages/domain/src/training.ts), shared with the web player's
 * <LessonVideo> render gate, which re-validates videoUrl with the same
 * parser and stays the AUTHORITATIVE XSS layer: this module is the
 * author-feedback layer.
 */
import { validateQuiz, youtubeVideoId, type QuizQuestion } from "@sinnlos/domain";

import { parseAdminJsonField } from "./json-field";

export { validateQuiz, youtubeVideoId };
export type { QuizQuestion };

/** Values validateLessonData normalised; a key is set only when `data` had it. */
export interface NormalizedLessonData {
  /** The quiz as validateQuiz returns it, or null for a cleared quiz. */
  quiz?: QuizQuestion[] | null;
}

export type LessonDataResult = { normalized: NormalizedLessonData } | { error: string };

export const QUIZ_NOT_JSON_ERROR = "quiz ist kein gültiges JSON";

/**
 * Validate the mutable lesson fields present in a lifecycle `data`
 * payload. KEYS-PRESENT RULE: only fields present in `data` are checked
 * (`"videoUrl" in data`). The admin panel submits the whole form, but
 * db.query and script writers send partial payloads, and a missing key
 * must never be read as "cleared".
 *
 * The quiz arrives in whatever shape the writer used (utils/json-field.ts):
 * an array (content API, or an admin form whose quiz was not touched), the
 * raw editor text (edited in the admin panel) or '' (cleared there). An
 * empty or whitespace string means null, any other string must be JSON.
 * The result carries the normalised quiz for the lifecycle to write back,
 * so the database always stores the array (or null). Idempotent: the
 * normalised value validates to itself, which matters because beforeCreate
 * runs again on every publish.
 *
 * Returns the normalised values, or a German error message for the admin
 * panel.
 */
export function validateLessonData(data: Record<string, unknown>): LessonDataResult {
  const normalized: NormalizedLessonData = {};
  if ("videoUrl" in data && data.videoUrl != null && data.videoUrl !== "") {
    if (youtubeVideoId(data.videoUrl) == null) {
      return {
        error:
          "videoUrl: nur YouTube-Links (https://www.youtube.com/watch?v=…, youtu.be/…, youtube-nocookie.com/embed/…)",
      };
    }
  }
  if ("quiz" in data && data.quiz !== undefined) {
    const parsed = parseAdminJsonField(data.quiz);
    if (!parsed.ok) return { error: QUIZ_NOT_JSON_ERROR };
    if (parsed.value === null) {
      normalized.quiz = null;
    } else {
      const result = validateQuiz(parsed.value);
      if ("error" in result) return { error: result.error };
      normalized.quiz = result.quiz;
    }
  }
  if ("order" in data && data.order != null) {
    const order = data.order;
    if (typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 10000) {
      return { error: "order: ganze Zahl zwischen 0 und 10000" };
    }
  }
  return { normalized };
}
