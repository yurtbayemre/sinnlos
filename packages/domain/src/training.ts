import type {
  AuthoringListRow,
  AuthoringPagination,
  EditableBase,
  EditableMedia,
} from "./authoring/dto.js";

/**
 * Training content rules (issue #29): the YouTube parser and the lesson quiz
 * schema. One implementation for both layers that check them (SH01):
 *   - the cms lesson lifecycle (apps/cms/src/utils/training-validation.ts,
 *     validateLessonData) is the author-feedback layer: it refuses a bad
 *     videoUrl or quiz with a German message in the admin panel;
 *   - the web player's <LessonVideo> render gate
 *     (apps/web/src/lib/training-shared.ts) is the AUTHORITATIVE XSS layer:
 *     the stored string is never rendered, the embed URL is rebuilt from the
 *     extracted id. Old rows and db-level writes bypass the lifecycle, so the
 *     player re-validates video URLs with the same parser. Stored quizzes
 *     are validated strictly before server feedback or completion.
 */

/** Hosts accepted for lesson videos: YouTube only (owner decision). */
const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract the 11-char YouTube video id, or null when the URL is not an
 * accepted YouTube URL. Only https, only known hosts, and the id must match
 * the strict pattern: the embed URL is later REBUILT from a template, the
 * stored string is never rendered as-is.
 */
export function youtubeVideoId(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;

  let candidate: string | null = null;
  if (url.hostname === "youtu.be") {
    candidate = url.pathname.slice(1).split("/")[0] ?? null;
  } else if (url.pathname === "/watch") {
    candidate = url.searchParams.get("v");
  } else if (
    url.pathname.startsWith("/embed/") ||
    url.pathname.startsWith("/shorts/") ||
    url.pathname.startsWith("/live/")
  ) {
    candidate = url.pathname.split("/")[2] ?? null;
  }
  return candidate && VIDEO_ID_RE.test(candidate) ? candidate : null;
}

/** Embed URL rebuilt from the validated id, never from the stored string. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * One question of a lesson quiz. Answers are never stored; a lesson with
 * questions completes only with every answer correct (quizAnswersPass,
 * issue #70).
 */
export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

/** Most questions per lesson quiz. */
export const QUIZ_MAX_QUESTIONS = 20;
/** Most answer options per question (at least 2). */
export const QUIZ_MAX_OPTIONS = 8;
/** Longest question or option text, in characters. */
export const QUIZ_MAX_TEXT = 500;

/**
 * Validate lesson quiz JSON for authoring and server grading. Expected shape:
 * [{ "question": "...", "options": ["...", ...], "correctIndex": 0 }, ...].
 * Returns the normalized (trimmed) array or an error string (German: it
 * surfaces in the Strapi admin panel).
 */
export function validateQuiz(raw: unknown): { quiz: QuizQuestion[] } | { error: string } {
  if (raw == null) return { quiz: [] };
  if (!Array.isArray(raw)) {
    return {
      error:
        'quiz muss ein JSON-Array sein: [{"question":"…","options":["…","…"],"correctIndex":0}]',
    };
  }
  if (raw.length > QUIZ_MAX_QUESTIONS) {
    return { error: `quiz: maximal ${QUIZ_MAX_QUESTIONS} Fragen` };
  }
  const quiz: QuizQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Record<string, unknown>;
    if (!q || typeof q !== "object" || Array.isArray(q))
      return { error: `quiz[${i}]: Objekt erwartet` };
    if (
      typeof q.question !== "string" ||
      q.question.trim() === "" ||
      q.question.length > QUIZ_MAX_TEXT
    ) {
      return {
        error: `quiz[${i}].question: nicht-leerer Text (max. ${QUIZ_MAX_TEXT} Zeichen) erforderlich`,
      };
    }
    const options = q.options;
    if (
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > QUIZ_MAX_OPTIONS ||
      options.some((o) => typeof o !== "string" || o.trim() === "" || o.length > QUIZ_MAX_TEXT)
    ) {
      return { error: `quiz[${i}].options: 2–${QUIZ_MAX_OPTIONS} nicht-leere Texte erforderlich` };
    }
    const idx = q.correctIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      return { error: `quiz[${i}].correctIndex: ganze Zahl zwischen 0 und ${options.length - 1}` };
    }
    quiz.push({
      question: q.question.trim(),
      options: options.map((o) => (o as string).trim()),
      correctIndex: idx,
    });
  }
  return { quiz };
}

/**
 * Defensive parse of the lesson quiz JSON (the read side). The cms lifecycle
 * validates on write, but old rows or db-level writes can bypass it:
 * malformed entries are silently dropped so the player never crashes on
 * content.
 */
export function parseQuiz(raw: unknown): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  const quiz: QuizQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || q.question.trim() === "") continue;
    if (!Array.isArray(q.options) || q.options.length < 2) continue;
    const options = q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "");
    if (options.length !== q.options.length) continue;
    const idx = q.correctIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= options.length)
      continue;
    quiz.push({ question: q.question, options, correctIndex: idx });
  }
  return quiz;
}

/**
 * Whether every submitted option matches a strictly validated quiz. Server
 * feedback and completion must call validateQuiz on stored content first;
 * the lenient display parser must never turn malformed content into a pass.
 * A legitimate lesson without questions completes manually.
 */
export function quizAnswersPass(quiz: readonly QuizQuestion[], answers: unknown): boolean {
  if (quiz.length === 0) return true;
  return (
    Array.isArray(answers) &&
    answers.length === quiz.length &&
    quiz.every((question, i) => answers[i] === question.correctIndex)
  );
}

// ---------------------------------------------------------------------------
// Shared learner and authoring contracts.

export type TrainingCompletionMode = "confirm" | "quizGate" | "exam";

/** Stored quiz is malformed: HTTP 400 with error.details.code; never a failed attempt. */
export const QUIZ_CONTENT_INVALID = "quizContentInvalid";

/** Learner responses select only these fields; parseQuiz requires an author answer key. */
export interface LearnerQuizQuestion {
  question: string;
  options: string[];
}

export interface TrainingCourseRef {
  documentId: string;
  title: string;
  slug: string;
}

/** GET /api/lessons/:id/player; published lesson and parent, no generic query parameters. */
export interface LessonPlayerResponse {
  data: {
    documentId: string;
    title: string;
    body: string | null;
    order: number;
    videoUrl: string | null;
    course: TrainingCourseRef & { completionMode: TrainingCompletionMode };
    quiz: LearnerQuizQuestion[];
  };
}

/** Zero-based unique question indices; at most 20 selections, each a valid option index. */
export interface QuizSelection {
  questionIndex: number;
  optionIndex: number;
}

/** Transport bounds shared by the CMS and web; the CMS also checks the current quiz's bounds. */
export function isQuizSelectionList(value: unknown): value is QuizSelection[] {
  if (!Array.isArray(value) || value.length > QUIZ_MAX_QUESTIONS) return false;
  const questions = new Set<number>();
  for (const selection of value) {
    if (
      !selection ||
      typeof selection !== "object" ||
      Array.isArray(selection) ||
      Object.keys(selection).length !== 2
    )
      return false;
    const { questionIndex, optionIndex } = selection as Record<string, unknown>;
    if (
      typeof questionIndex !== "number" ||
      !Number.isInteger(questionIndex) ||
      questionIndex < 0 ||
      questionIndex >= QUIZ_MAX_QUESTIONS ||
      questions.has(questionIndex) ||
      typeof optionIndex !== "number" ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= QUIZ_MAX_OPTIONS
    )
      return false;
    questions.add(questionIndex);
  }
  return true;
}
/** POST /api/lessons/:id/check; confirm permits partial answers, other modes require all. */
export interface QuizCheckRequest {
  data: { answers: QuizSelection[] };
}

export interface QuizVerdict {
  questionIndex: number;
  correct: boolean;
}

/** Feedback never writes a receipt; mode comes from the current published course. */
export interface QuizCheckResponse {
  data: {
    completionMode: TrainingCompletionMode;
    /** True only when every question was submitted and passed. */
    passed: boolean;
    /** Omitted for exam, including completed review; otherwise only submitted questions. */
    verdicts?: QuizVerdict[];
  };
}

/** Existing POST /api/lesson-progresses payload; the server independently regrades. */
export interface LessonCompletionRequest {
  data: {
    targetDocumentId: string;
    /** One option index per question; omitted for a legitimate no-quiz lesson. */
    answers?: number[];
  };
}

export interface CourseEditable extends EditableBase {
  roleClass: "moderator";
  title: string;
  slug: string;
  description: string | null;
  mandatory: boolean;
  completionMode: TrainingCompletionMode;
  coverImage: EditableMedia | null;
  publishAt: string | null;
  scheduleError: string | null;
}

export interface LessonEditable extends EditableBase {
  roleClass: "moderator";
  title: string;
  body: string | null;
  order: number;
  /** A missing/deleted parent can be repaired; a course is required on create. */
  course: TrainingCourseRef | null;
  videoUrl: string | null;
  /** Author contract includes correctIndex; never serialize into learner responses. */
  quiz: QuizQuestion[];
  publishAt: string | null;
  scheduleError: string | null;
}

export interface LessonAuthoringListRow extends AuthoringListRow {
  course: TrainingCourseRef | null;
  order: number;
}

export interface LessonAuthoringListResponse {
  data: LessonAuthoringListRow[];
  meta: { pagination: AuthoringPagination };
}
