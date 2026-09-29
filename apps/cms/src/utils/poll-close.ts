/**
 * The poll close rule (datetime contract, deep-dive decision 04, C7): a poll
 * is closed iff now >= closesAt. One rule for the cms vote handler and the
 * web, in @sinnlos/domain (SH01, packages/domain/src/poll-close.ts). No
 * closesAt means the poll never closes; a value that is no instant counts
 * as open (Strapi only stores valid datetimes and reads them back as ISO-Z).
 */
export { isPollClosed } from "@sinnlos/domain";
