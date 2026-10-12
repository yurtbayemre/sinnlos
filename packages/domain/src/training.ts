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
 *     player re-validates with the same parser and reads quizzes leniently
 *     (parseQuiz).
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

/** One self-check question of a lesson quiz (no grading, no persistence). */
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
 * Validate the lesson quiz JSON strictly (the write side). Expected shape:
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
