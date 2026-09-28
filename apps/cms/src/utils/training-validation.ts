/**
 * Server-side validation for admin-authored training content (issue
 * #29) — pure and unit tested, consumed by the lesson lifecycles.
 *
 * WHY LIFECYCLES NEED THIS: admin-panel writes bypass every content-api
 * controller override, and until this module the repo had NO validation
 * that applies to admin writes at all (quick-link.url and poll.options
 * are unvalidated for exactly that reason). The lesson lifecycle is the
 * repo's first validating beforeCreate/beforeUpdate.
 *
 * MIRROR-PAIR RULE (like audience.ts ↔ announcement-audience.ts): the
 * web player's <LessonVideo> render gate re-validates videoUrl with the
 * same rules and stays the AUTHORITATIVE XSS layer — this module is the
 * author-feedback layer. Keep the two in sync; the web copy lives in
 * apps/web/src/lib/training-shared.ts (separate Docker build contexts,
 * no shared import possible).
 */

import { parseAdminJsonField } from "./json-field";

/** Hosts we accept for lesson videos — YouTube only (user decision). */
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
 * accepted YouTube URL. Only https, only known hosts, id must match the
 * strict pattern — the embed URL is later REBUILT from a template, the
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
  } else if (url.pathname.startsWith("/embed/") || url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/live/")) {
    candidate = url.pathname.split("/")[2] ?? null;
  }
  return candidate && VIDEO_ID_RE.test(candidate) ? candidate : null;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 8;
const MAX_TEXT = 500;

/**
 * Validate the lesson quiz JSON (self-check, no grading/persistence).
 * Expected shape: [{ "question": "...", "options": ["...", ...],
 * "correctIndex": 0 }, ...]. Returns the normalized array or an error
 * string (German — it surfaces in the Strapi admin panel).
 */
export function validateQuiz(raw: unknown): { quiz: QuizQuestion[] } | { error: string } {
  if (raw == null) return { quiz: [] };
  if (!Array.isArray(raw)) {
    return { error: 'quiz muss ein JSON-Array sein: [{"question":"…","options":["…","…"],"correctIndex":0}]' };
  }
  if (raw.length > MAX_QUESTIONS) return { error: `quiz: maximal ${MAX_QUESTIONS} Fragen` };
  const quiz: QuizQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as Record<string, unknown>;
    if (!q || typeof q !== "object" || Array.isArray(q)) return { error: `quiz[${i}]: Objekt erwartet` };
    if (typeof q.question !== "string" || q.question.trim() === "" || q.question.length > MAX_TEXT) {
      return { error: `quiz[${i}].question: nicht-leerer Text (max. ${MAX_TEXT} Zeichen) erforderlich` };
    }
    const options = q.options;
    if (
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > MAX_OPTIONS ||
      options.some((o) => typeof o !== "string" || o.trim() === "" || o.length > MAX_TEXT)
    ) {
      return { error: `quiz[${i}].options: 2–${MAX_OPTIONS} nicht-leere Texte erforderlich` };
    }
    const idx = q.correctIndex;
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      return { error: `quiz[${i}].correctIndex: ganze Zahl zwischen 0 und ${options.length - 1}` };
    }
    quiz.push({ question: q.question.trim(), options: options.map((o) => (o as string).trim()), correctIndex: idx });
  }
  return { quiz };
}

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
