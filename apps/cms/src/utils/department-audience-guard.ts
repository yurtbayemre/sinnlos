import { DEPARTMENT_SCOPED_TYPES } from "./department-delete-restrict";
import {
  createAudienceGuard,
  useDocumentMiddleware,
  type DocumentMiddleware,
  type PollAudienceGuardHost,
  type PollAudienceGuardRegistrationHost,
} from "./poll-audience-guard";

/**
 * Write-time enforcement of the document and quick-link audience flag
 * (FX29 residual, the poll pattern; batch 12 review B12-01): every row of
 * a document or quick link that links a department carries
 * `audience = 'departments'` from the moment the write that linked it
 * commits.
 *
 * WHY. Both types are scoped by their `departments` links, "flag OR links"
 * (utils/policy-factories.ts departmentScopedIds). Deleting a department
 * cascades the links away, and the department delete hook
 * (utils/department-delete-restrict.ts) flags the rows it finds first. A
 * flag set only then comes too late for a write that copied the row
 * earlier:
 *   - a publish (or "Discard changes") that read the draft (Audience `all`,
 *     linking the department) before the delete committed, then waited for
 *     the rows the delete locked, recreates the published row (the draft)
 *     from that copy afterwards. @strapi/core 5.55.1 transforms the copy
 *     with `allowMissingId: true` (document-service/entries.js publishEntry,
 *     discardDraftEntry; transform/relations/transform/data-ids.js), so the
 *     deleted department is dropped silently and the row comes out with
 *     `all` and no department: company-wide, guests included;
 *   - an admin form opened while the row still linked the department shows
 *     Audience `all` (the schema default); saved or published after the
 *     delete, it sends `all` back with the other fields, and the relation
 *     only as connect/disconnect changes.
 * With this guard (and the boot backfill, utils/department-audience-
 * backfill.ts, for the rows written before it) such a copy already says
 * 'departments', so the row stays restricted. The delete hook stays as
 * defence in depth.
 *
 * HOW. The poll guard's middleware (utils/poll-audience-guard.ts, which see
 * for the Strapi 5.55.1 mechanics): a Document Service middleware that runs
 * every writing action (create, update, clone, publish, unpublish,
 * discardDraft) inside a transaction it opens first, then sets the flag on
 * every row (draft and published) of the affected documents that links a
 * department, with `updateMany` (`updatedAt` untouched), and patches the
 * action's result, so the admin form and the API response show the stored
 * flag. The writers are the same as for polls: the Content Manager (single
 * and bulk), the content API (admin_role and editor), the entity service
 * shim, the demo seed and the draft-twin repair.
 *
 * NEVER WIDENS, and the panel rule that follows (as for polls): the guard
 * only sets 'departments', on rows that link a department. Removing every
 * department of a document or quick link therefore no longer makes it
 * company-wide on its own; it stays for admins and editors until the
 * editor also sets Audience to `all` (decision 06 §B1.2 derives the flag
 * the same way for v2 writes). Setting `all` while departments remain is
 * flipped back to 'departments'.
 */

export const DEPARTMENT_AUDIENCE_LOG = "[department-audience]";

/** The middleware for documents and quick links. */
export function createDepartmentAudienceGuard(strapi: PollAudienceGuardHost): DocumentMiddleware {
  return createAudienceGuard(strapi, DEPARTMENT_AUDIENCE_LOG, DEPARTMENT_SCOPED_TYPES);
}

/**
 * Registers the guard in register(). Fails the boot when the Document
 * Service has no `use` (a Strapi upgrade moved it): the cms must not run
 * without it.
 */
export function registerDepartmentAudienceGuard(strapi: PollAudienceGuardRegistrationHost): void {
  useDocumentMiddleware(
    strapi,
    createDepartmentAudienceGuard(strapi),
    `${DEPARTMENT_AUDIENCE_LOG} strapi.documents.use not found — refusing to boot without the write-time document and quick-link audience guard`,
  );
}
