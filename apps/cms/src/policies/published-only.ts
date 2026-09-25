import { hasAudienceBypass } from "../utils/announcement-audience";
import { forcePublishedStatus, getMutableQuery } from "../utils/policy-query";

/**
 * Pins reads of a draft & publish type to PUBLISHED rows (FX06, §5.24).
 *
 * For types whose reads need no row filter (event, department, team, and
 * poll until its audience policy lands). Without any read policy the core
 * service merges the client's params OVER its default —
 * `getFetchParams` = `{ status: 'published', ...params }` — so every role
 * holding `<type>.find` read unpublished drafts by appending `?status=draft`
 * (full trap: `forcePublishedStatus` in utils/policy-query.ts).
 *
 * admin_role / editor bypass FIRST and keep draft reads (they author the
 * drafts); everyone else — including an anonymous caller — gets
 * `status=published` written onto the REAL query via getMutableQuery
 * (`policyContext.query` is a throw-away copy, §5.14), which also removes
 * the legacy v4 `publicationState`. Composes with the global relation guard
 * (FX05, runs later in sanitize.query on other keys). Harmless on a type whose
 * draftAndPublish is later switched off: the document service ignores
 * `status` there. Returns a strict boolean (undefined counts as PASS).
 *
 * Do NOT stack it with a visibility policy that already pins the status
 * (announcement-, document-, quick-link-, wiki-, training-visibility, and
 * the planned poll-visibility of decisions/02 — which replaces it on poll).
 */

interface PolicyContext {
  state?: { user?: { role?: { type?: string } | null } | null };
  request?: { query?: Record<string, unknown> };
}

export default (policyContext: PolicyContext): boolean => {
  if (hasAudienceBypass(policyContext.state?.user?.role?.type)) return true;
  forcePublishedStatus(getMutableQuery(policyContext));
  return true;
};
