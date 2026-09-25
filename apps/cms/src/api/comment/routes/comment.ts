import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::comment.comment", {
  // No update route (FX01): comments are not editable in the web, and the
  // core PUT ran without policy or controller override.
  only: ["find", "findOne", "create", "delete"],
  config: {
    // Reads are filtered to targets the caller may see (#28); the create
    // counterpart lives in the controller (needs the resolved anchor).
    find: { policies: ["global::comment-target-visibility"] },
    findOne: { policies: ["global::comment-target-visibility"] },
    create: { policies: [] },
    delete: { policies: [] },
  },
});
