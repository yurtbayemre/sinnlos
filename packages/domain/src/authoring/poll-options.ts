import type { AuthoringFieldCode } from "./codes.js";

/**
 * The answer options of a poll (FX20; deep-dive decision 06 §B1.3; batch 15
 * plan item 2b, contract K7): a JSON array of MIN_POLL_OPTIONS to
 * MAX_POLL_OPTIONS answer texts, each non-empty and unique after trimming.
 * One rule for every writer:
 *   - the cms poll lifecycle applies `validatePollOptions` to every write,
 *     the admin panel included (apps/cms/src/api/poll/content-types/poll/
 *     lifecycles.ts, through apps/cms/src/utils/poll-options.ts, a
 *     re-export of this module);
 *   - the cms authoring allowlist and the web form also hold every option
 *     to MAX_POLL_OPTION_LENGTH (`pollOptionsCode` with `maxLength`). The
 *     lifecycle does not, so a legacy or panel poll with a longer option
 *     still saves in the panel; a web edit that changes its options must
 *     meet the limit.
 *
 * Votes point at an option by its INDEX (poll-vote.optionIndex), so the
 * rule never repairs a list by dropping entries: an empty or duplicate
 * answer is refused, because removing it would shift the index of every
 * later answer and move existing votes. Trimming keeps the indices.
 *
 * Raising the count bound (10 until batch 15) cannot invalidate a stored
 * poll; lowering it could, so it only grows.
 */

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 20;
/** Characters per answer, for content-API and web writes (not the lifecycle). */
export const MAX_POLL_OPTION_LENGTH = 200;

export type PollOptionsResult = { options: string[] } | { error: string };

/**
 * The lifecycle's check: the trimmed options, or an error message for the
 * admin panel and the content API (a ValidationError there).
 */
export function validatePollOptions(raw: unknown): PollOptionsResult {
  if (!Array.isArray(raw) || raw.length < MIN_POLL_OPTIONS || raw.length > MAX_POLL_OPTIONS) {
    return {
      error: `options: a JSON array of ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} answer texts is required, e.g. ["Yes","No"]`,
    };
  }
  const options: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const value: unknown = raw[i];
    if (typeof value !== "string" || value.trim() === "") {
      return { error: `options[${i}]: a non-empty text is required` };
    }
    const text = value.trim();
    if (options.includes(text)) {
      return { error: `options[${i}]: "${text}" repeats options[${options.indexOf(text)}]` };
    }
    options.push(text);
  }
  return { options };
}

/**
 * The field code of a refused options value, or null when it passes
 * (`maxLength`: the per-answer limit of the allowlist and the web form):
 *   - not an array, or an entry that is no string: `invalid`;
 *   - too few or too many answers: `optionCount`;
 *   - an empty or blank answer: `required`;
 *   - an answer longer than `maxLength` after trimming: `tooLong`;
 *   - two answers equal after trimming: `optionDuplicate`.
 */
export function pollOptionsCode(
  raw: unknown,
  { maxLength }: { maxLength?: number } = {},
): AuthoringFieldCode | null {
  if (!Array.isArray(raw)) return "invalid";
  if (raw.length < MIN_POLL_OPTIONS || raw.length > MAX_POLL_OPTIONS) return "optionCount";
  const seen = new Set<string>();
  for (const value of raw as unknown[]) {
    if (typeof value !== "string") return "invalid";
    const text = value.trim();
    if (text === "") return "required";
    if (maxLength !== undefined && text.length > maxLength) return "tooLong";
    if (seen.has(text)) return "optionDuplicate";
    seen.add(text);
  }
  return null;
}

/**
 * Whether two option lists say the same thing to a voter: the same length
 * and, index by index, the same text after trimming (votes point at an
 * index). Anything that is no list of strings is compared as it is.
 */
export function samePollOptions(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value: unknown, i) => {
    const other: unknown = b[i];
    return typeof value === "string" && typeof other === "string"
      ? value.trim() === other.trim()
      : value === other;
  });
}
