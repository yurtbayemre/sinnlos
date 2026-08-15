import { factories } from "@strapi/strapi";
import { wikiEditContext } from "../../../utils/wiki-edit-context";

export default factories.createCoreController("api::wiki-page.wiki-page", () => ({
  async update(ctx) {
    const user = ctx.state.user;
    const data = (ctx.request.body as any)?.data;

    let revisionSummary: string | undefined;
    if (data && typeof data === "object") {
      // `revisionSummary` is not a schema attribute — the core input
      // validation rejects unknown keys — so pull it out of the payload
      // and hand it to the revision lifecycle via the request-scoped
      // bridge instead.
      if (typeof data.revisionSummary === "string") {
        revisionSummary = data.revisionSummary;
      }
      delete data.revisionSummary;
      // Server-authoritative editor: never trust a client-sent lastEditor.
      if (user) data.lastEditor = user.id;
    }

    return wikiEditContext.run({ editorId: user?.id, revisionSummary }, () =>
      super.update(ctx),
    );
  },
}));
