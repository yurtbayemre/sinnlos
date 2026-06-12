import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::comment.comment", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: [] },
    update: { policies: [] },
    delete: { policies: [] },
  },
});
