import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::reaction.reaction", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: [] },
    delete: { policies: [] },
  },
});
