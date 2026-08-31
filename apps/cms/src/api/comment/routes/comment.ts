import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::comment.comment", {
  config: {
    // Reads are filtered to targets the caller may see (#28); the create
    // counterpart lives in the controller (needs the resolved anchor).
    find: { policies: ["global::comment-target-visibility"] },
    findOne: { policies: ["global::comment-target-visibility"] },
    create: { policies: [] },
    update: { policies: [] },
    delete: { policies: [] },
  },
});
