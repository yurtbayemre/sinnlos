/**
 * The poll close rule (datetime contract, deep-dive decision 04, C7), used
 * by the polls page (server), the poll card (client) and the poll form
 * action, from @sinnlos/domain (SH01, packages/domain/src/poll-close.ts):
 * the rule the cms vote handler applies too.
 *
 *  - A poll is closed iff now >= closesAt.
 *  - The form's "closes on D" means the end of day D in APP_TIME_ZONE,
 *    stored as the instant D 23:59:59 there, whatever zone the web process
 *    or the browser runs in.
 */
export { POLL_CLOSING_TIME, isPollClosed, pollClosesAtForDay } from "@sinnlos/domain";
