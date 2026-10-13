import { factories } from "@strapi/strapi";

/**
 * No content-API route (decision 06 §J3 "Generic routes", batch 15.1): a
 * revision snapshots the page body BEFORE an edit, and that body is the
 * page's draft whenever the draft differs from the published version, so
 * these reads handed out unpublished wiki text to every staff role. The
 * grants are revoked for every role (REVOKED_PERMISSIONS in
 * bootstrap/permission-matrix.ts); without a `wiki-revision.find` grant the
 * core also drops or refuses every populate and filter through
 * `wiki-page.revisions`, and the relation guard closes the shapes the core
 * does not check (CLOSED_RELATION_TARGETS in utils/restricted-relations.ts).
 * The lifecycle still writes revisions; batch 16 reads them through the
 * wiki-page history actions only. The web reads none (FX24).
 */
export default factories.createCoreRouter("api::wiki-revision.wiki-revision", { only: [] });
