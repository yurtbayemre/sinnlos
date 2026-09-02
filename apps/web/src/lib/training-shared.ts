/**
 * Pure training helpers (issue #29). MIRROR-PAIR RULE: youtubeVideoId
 * mirrors apps/cms/src/utils/training-validation.ts — the CMS lifecycle
 * is the author-feedback layer, THIS side (the <LessonVideo> render
 * gate) is the AUTHORITATIVE XSS layer: the stored string is never
 * rendered; the embed URL is rebuilt from the extracted id. Keep both
 * copies in sync (separate Docker build contexts, no shared import —
 * same situation as audience.ts ↔ announcement-audience.ts).
 */

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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

/** Embed URL rebuilt from the validated id — never from the stored string. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

/**
 * Defensive parse of the lesson quiz JSON. The CMS lifecycle validates
 * on write, but old rows or db-level writes can bypass it — malformed
 * entries are silently dropped so the player never crashes on content.
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

export interface CourseLessonRef {
  documentId?: string | null;
}

/**
 * Course completion is DERIVED at read time — never materialized: the
 * set of the user's completed lesson documentIds must cover the course's
 * CURRENT lesson list. Inherently idempotent against duplicate progress
 * rows (#16 race class) and a lesson added later automatically re-opens
 * the course for everyone (confirmed product decision).
 * Fail-closed: a course with zero lessons is never "completed".
 */
export function courseCompletion(
  lessons: CourseLessonRef[],
  completedDocumentIds: Set<string>,
): { total: number; completed: number; done: boolean } {
  const ids = lessons
    .map((l) => l.documentId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const completed = ids.filter((id) => completedDocumentIds.has(id)).length;
  return { total: ids.length, completed, done: ids.length > 0 && completed === ids.length };
}

/** Sort contract for lessons: order:asc, then id:asc as the stable tiebreak. */
export function sortLessons<T extends { order?: number | null; id: number }>(lessons: T[]): T[] {
  return [...lessons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

export type CompletionMode = "confirm" | "quizGate";

export interface QuizEvaluation {
  /** Question indexes answered wrongly (empty = all correct). */
  wrong: number[];
  /** True when every question has an answer AND all are correct. */
  passed: boolean;
  answeredAll: boolean;
}

/**
 * Batch evaluation for the quiz-gate flow (pure, tested): answers map
 * question index → picked option index. Unanswered questions count as
 * not passed but not as "wrong" (the UI nudges for completeness first).
 * An empty quiz passes trivially — a quizGate course whose lesson has
 * no (or malformed → dropped) quiz must not dead-lock completion;
 * content errors fail open by design.
 */
export function evaluateQuiz(
  quiz: QuizQuestion[],
  answers: Record<number, number | undefined>,
): QuizEvaluation {
  const wrong: number[] = [];
  let answered = 0;
  quiz.forEach((q, i) => {
    const picked = answers[i];
    if (picked === undefined) return;
    answered++;
    if (picked !== q.correctIndex) wrong.push(i);
  });
  const answeredAll = answered === quiz.length;
  return { wrong, answeredAll, passed: answeredAll && wrong.length === 0 };
}
