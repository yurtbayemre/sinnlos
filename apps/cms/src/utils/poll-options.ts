/**
 * The answer options of a poll (FX20): a JSON array of MIN_POLL_OPTIONS to
 * MAX_POLL_OPTIONS (2 to 20) answer texts, each non-empty and unique after
 * trimming. The rule lives in @sinnlos/domain (packages/domain/src/
 * authoring/poll-options.ts; batch 15 plan item 2b), shared with the
 * authoring allowlist (utils/write-allowlist.ts, which also caps each
 * answer at MAX_POLL_OPTION_LENGTH) and the web form. This module keeps the
 * cms path the poll lifecycle (api/poll/content-types/poll/lifecycles.ts)
 * imports, which applies `validatePollOptions` to every writer, the admin
 * panel included, where editors author polls.
 *
 * Votes point at an option by its INDEX (poll-vote.optionIndex), so the
 * validator never repairs a list by dropping entries.
 */
export {
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_LENGTH,
  MIN_POLL_OPTIONS,
  validatePollOptions,
  type PollOptionsResult,
} from "@sinnlos/domain";
