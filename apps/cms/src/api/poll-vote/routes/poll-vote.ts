import { factories } from "@strapi/strapi";

export default factories.createCoreRouter("api::poll-vote.poll-vote", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
  },
});
