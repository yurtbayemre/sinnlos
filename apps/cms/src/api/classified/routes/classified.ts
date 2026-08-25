import { factories } from "@strapi/strapi";

/**
 * Reads are open to every role including guest (an internal flea market is
 * company-public; expired ads are merely filtered client-side, they are not
 * confidential). Create is limited via the bootstrap permission matrix to
 * member/team_lead/department_head/editor/admin — the controller then pins
 * the author to the caller. update/delete additionally require ownership
 * via the policy below: editing bypasses ownership only for admins, while
 * delete keeps the editor takedown (moderation) bypass.
 */
export default factories.createCoreRouter("api::classified.classified", {
  config: {
    update: {
      policies: [{ name: "global::is-classified-author", config: { bypassRoles: ["admin_role"] } }],
    },
    delete: {
      policies: [
        {
          name: "global::is-classified-author",
          config: { bypassRoles: ["admin_role", "editor"] },
        },
      ],
    },
  },
});
