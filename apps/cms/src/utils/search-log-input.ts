/**
 * Server-authoritative sanitization of a search-log write (issue #19).
 * Pure so the trust boundary is unit testable: whatever the client sends,
 * the stored row is a lowercased, trimmed, length-capped term plus a
 * clamped integer count — and NOTHING else (no user, no extra keys).
 */

const MAX_TERM_LENGTH = 120;
const MAX_RESULT_COUNT = 100000;

export interface SearchLogInput {
  term: string;
  resultCount: number;
}

export function sanitizeSearchLogInput(body: unknown): SearchLogInput | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.term !== "string") return null;
  // Lowercase so the SQL GROUP BY in the summary aggregates "Urlaub" and
  // "urlaub" into one bucket; collapse inner whitespace for the same reason.
  const term = raw.term.trim().replace(/\s+/g, " ").toLowerCase().slice(0, MAX_TERM_LENGTH);
  if (term.length < 2) return null;

  const count = Number(raw.resultCount);
  if (!Number.isFinite(count)) return null;
  const resultCount = Math.min(MAX_RESULT_COUNT, Math.max(0, Math.round(count)));

  return { term, resultCount };
}
