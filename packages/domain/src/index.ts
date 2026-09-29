/**
 * @sinnlos/domain: the pure rules the cms and the web share (SH01). No
 * runtime dependencies, no I/O, no process access: every module runs in the
 * cms (CommonJS), in web server code and in web client components. Database
 * lookups stay in the cms; the apps keep their old module paths as thin
 * re-exports (e.g. apps/cms/src/utils/plain-date.ts, apps/web/src/lib/
 * plain-date.ts), so importers did not change.
 */
export * from "./audience.js";
export * from "./classified.js";
export * from "./comment-target.js";
export * from "./entry-id.js";
export * from "./live-contract.js";
export * from "./plain-date.js";
export * from "./poll-close.js";
export * from "./roles.js";
export * from "./training.js";
