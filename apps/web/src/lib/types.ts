/**
 * Lightweight types for the Strapi entities the frontend renders, split per
 * domain under lib/types/ (WD01) and re-exported here, so `@/lib/types`
 * stays the one import for components, the api modules and the cross-app
 * contract test (infra/contracts.test.ts).
 *
 * Fields are optional-by-default because population varies per query;
 * these exist to replace the previous `any` casts with real signal. What a
 * given read actually delivers (its field-limited populates) is the view
 * type of its lib/api/*.ts module.
 */
export type * from "./types/common";
export type * from "./types/org";
export type * from "./types/wiki";
export type * from "./types/announcements";
export type * from "./types/social";
export type * from "./types/events";
export type * from "./types/polls";
export type * from "./types/documents";
export type * from "./types/marketplace";
export type * from "./types/kudos";
export type * from "./types/training";
export type * from "./types/quick-links";
