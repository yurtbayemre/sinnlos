/**
 * The answer options of a poll (FX20): a JSON array of 2 to 10 answer texts,
 * each a non-empty string, unique after trimming. Pure; the poll lifecycle
 * (api/poll/content-types/poll/lifecycles.ts) applies it to every writer,
 * the admin panel included, where editors author polls.
 *
 * Votes point at an option by its INDEX (poll-vote.optionIndex), so the
 * validator never repairs a list by dropping entries: an empty or duplicate
 * answer is refused, because removing it would shift the index of every
 * later answer and move existing votes. Trimming keeps the indices.
 *
 * 10 is the web form's MAX_OPTIONS (apps/web/src/components/polls/
 * poll-form.tsx); the web createPoll action trims and dedupes before it
 * sends, so every web-created poll passes.
 */

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;

export type PollOptionsResult = { options: string[] } | { error: string };

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
      return { error: `options[${i}]: "${text}" is already answer ${options.indexOf(text) + 1}` };
    }
    options.push(text);
  }
  return { options };
}
