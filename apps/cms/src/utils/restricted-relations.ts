import { errors } from "@strapi/utils";

/**
 * Relation side channels into visibility-filtered content types (FX05).
 *
 * Why: the read-filter policies (wiki-visibility, ...) narrow only the ROOT
 * query of their own routes. A relation from any other type hands the
 * filtered rows out past that policy: `department.pages` and `team.pages`
 * (inverse sides of wiki-page.department/team) reach the pages of every wiki
 * space, including hidden spaces. They are reachable from every route whose
 * model gets to a department or team, at any depth, on reads AND writes:
 *   - populate: `/api/departments?populate[pages]`, but equally
 *     `/api/users?populate[department][populate][pages]` (db.query: drafts
 *     too), `/api/users/me`, wiki-spaces, announcements, events, polls, and
 *     the response of `PUT /api/teams/:id?populate[pages]`,
 *   - a blind oracle through filters and sort:
 *     `filters[pages][body][$startsWith]=Conf`, `sort=pages.title:asc`,
 *     `populate[teams][filters][pages][title][$lt]=M` join on the hidden
 *     rows, so the result depends on their content.
 * The core only checks `<target>.find` (validateQuery's
 * throwRestrictedRelations on filters and sort; in 5.55.1 sanitizePopulate's
 * removeRestrictedRelations on populate, where 5.49 threw a 400 instead),
 * which every role holds on wiki-page, so the core lets all of them through.
 *
 * The rule is per RELATION, not per route. `RESTRICTED_RELATION_TARGETS`
 * lists each filtered target with the only source types that may point at
 * it. Those are its own filter domain: wiki-space.pages and wiki-page.parent/
 * children sit behind wiki-visibility at their roots. Every other relation
 * into the target is cut at any depth from any root.
 * A relation WITHOUT a static target (morph, e.g. the upload file's
 * `related`) counts as restricted: it may point anywhere.
 * routes.matrix.test.ts derives every such relation from the schemas and
 * fails when one is not covered.
 *
 * `CLOSED_RELATION_TARGETS` (batch 15.1) lists targets no content-API caller
 * may reach through any relation, admin_role and editor included: wiki
 * revisions, which hold the page body before each edit, draft text
 * included. No role holds `wiki-revision.find`, so the core already drops a
 * populate of `wiki-page.revisions` and refuses a root filter or sort
 * through it; but it checks neither the filters nor the sort INSIDE a
 * populate (@strapi/utils 5.57 traverse/query-populate.js skips those keys,
 * validate/index.js validatePopulate passes no auth):
 * `/api/wiki-spaces?populate[pages][filters][revisions][body][$startsWith]=…`
 * answered with the pages whose revisions match, for every role.
 *
 * Grants inside populate (batch 15.2): the gap above is not specific to
 * wiki revisions. At the root the core refuses a filter or sort through a
 * relation whose target the caller holds no `find` on; inside a populate it
 * never asks, so `/api/wiki-spaces?populate[pages][filters][department]
 * [name][$eq]=…` let guest (no `department.find`) select through
 * departments, and `populate[author][filters][role][type][$eq]=admin_role`
 * let every role below admin_role probe users' roles. The walk reports each
 * relation a populate's `filters` or `sort` follow (`onPopulateQueryRelation`,
 * at any depth, through `$and`/`$or`/`$not`), and the guard refuses the first
 * one whose target the caller cannot `find` (assertPopulateQueryGrants),
 * with the core's root answer. Every caller, admin_role and editor included.
 *
 * What happens to a restricted relation (closed targets for every caller,
 * the rest for non admin_role/editor callers; registerRestrictedRelationGuard
 * in bootstrap/restricted-relation-guard.ts decides the bypass):
 *   - populate: dropped with everything nested under it, in every shape the
 *     core accepts (@strapi/utils convert-query-params.js, @strapi/database
 *     populate/process.js): objects, counts, strings, comma lists, arrays,
 *     dotted paths (truncated to the safe prefix) and every `*` form. A
 *     projection only narrows the output, so stripping is safe and the rest
 *     of the request keeps working.
 *   - filters and sort (root, `$and`/`$or`/`$not`, and inside populate
 *     objects): rejected with the core's own `Invalid key` ValidationError
 *     (400). Dropping a clause would silently change WHICH rows match;
 *     rejecting keeps the answer a function of the query shape alone.
 *   - output (backstop): the key is deleted from every response entity.
 *
 * Fail-closed choices: a dynamic-zone populate object collapses to `true`
 * (no dynamic zones exist; their fragments could otherwise hide a
 * restricted relation). A dotted populate path that walks into an
 * unresolvable model is truncated there.
 *
 * No Strapi runtime: the schema comes in through `getModel`, so it is unit
 * testable (see restricted-relations.test.ts).
 */

/** The slice of a Strapi attribute definition the walk depends on. */
export interface RelationAttribute {
  type?: string;
  /** Relation target uid; missing on morph relations. */
  target?: string;
  /** Component uid. */
  component?: string;
  private?: boolean;
}

/** The slice of a Strapi model the walk depends on. */
export interface RelationModel {
  uid?: string;
  attributes?: Record<string, RelationAttribute>;
  options?: { privateAttributes?: string[] };
}

/** Filtered target uid → the only source uids whose relations may reach it. */
export type RestrictedRelationRules = Readonly<Record<string, readonly string[]>>;

/**
 * The trusted sources must share the target's filter domain: their own reads
 * are narrowed by the same policy family, so a path from a visible root
 * never reaches a row that policy would hide (routes.matrix.test.ts pins
 * this).
 *
 * That also needs the trusted relations to stay inside one wiki space, which
 * the write side enforces (FX07) for every caller without the admin_role/
 * editor bypass:
 *   - wiki-page `space` is create-only and must be a space the caller can
 *     read; `parent` must be a readable page of the same space, and never
 *     the page itself or a descendant (can-edit-wiki → utils/write-allowlist.ts,
 *     utils/wiki-write-targets.ts),
 *   - `children` and `revisions` (the inverse sides) are not writable at all,
 *     and neither are department/team `pages`,
 *   - an existing page is only editable while it sits in a space the caller
 *     can read, so a write response cannot walk space.pages/parent/children
 *     of a hidden space,
 *   - those writes always publish (enforceWriteAllowlist pins `status`, as
 *     the read policies do), so a write response populates published rows
 *     only and never the drafts the read routes hide,
 *   - wiki-space writes are admin/editor-only; wiki-revision has no route.
 * admin/editor writes (content API and admin panel) are trusted to keep a
 * page's parent in its own space. routes.matrix.test.ts fails when a role
 * without the bypass gains a write route that could set one of these
 * relations outside the allowlist.
 *
 * wiki-revision is no trusted source any more (batch 15.1): it has no
 * route, so no query starts there, and the only way into it,
 * `wiki-page.revisions`, is closed (CLOSED_RELATION_TARGETS).
 */
export const RESTRICTED_RELATION_TARGETS: RestrictedRelationRules = {
  "api::wiki-page.wiki-page": [
    "api::wiki-page.wiki-page", // parent / children
    "api::wiki-space.wiki-space", // pages
  ],
  // Poll department targeting (decision 02): poll-visibility narrows the
  // poll routes only. The one relation into poll, poll-vote.poll, has no
  // content-API route today (the poll-vote router is `only: []`); this
  // entry keeps it, and any relation added later, from handing out polls
  // outside their audience. No source is trusted.
  "api::poll.poll": [],
  // Comment target visibility (#28, batch 15.2): comment-target-visibility
  // narrows the comment routes per TARGET (targetType + targetDocumentId),
  // and nothing keeps comment.parent/replies on one target: the content API
  // never writes them (FX04 builds the create payload without them), but a
  // create before FX04 could point `parent` at any comment, and the admin
  // panel still can. Such a link handed out a comment under a hidden
  // announcement or wiki page through `populate[parent]`, and filters and
  // sort through it were an oracle on its body. The web uses neither
  // relation. No source is trusted; admin_role and editor read every
  // comment anyway (the policy's bypass) and keep both.
  "api::comment.comment": [],
};

/**
 * Targets closed for EVERY content-API caller, the admin_role/editor bypass
 * included (see the header): no source is trusted. The admin panel does not
 * go through the content API.
 */
export const CLOSED_RELATION_TARGETS: RestrictedRelationRules = {
  "api::wiki-revision.wiki-revision": [],
};

/** The rules a caller without the admin_role/editor bypass is held to: both sets. */
export const NON_BYPASS_RELATION_TARGETS: RestrictedRelationRules = {
  ...RESTRICTED_RELATION_TARGETS,
  ...CLOSED_RELATION_TARGETS,
};

/**
 * A relation that a populate's `filters` or `sort` follow: its target, and
 * the key and path that the core's `Invalid key` names.
 */
export interface PopulateQueryRelation {
  target: string;
  key: string;
  path: string;
}

export interface RestrictedRelationOptions {
  /** Resolve a model uid to its schema (strapi.getModel); may return undefined. */
  getModel: (uid: string) => RelationModel | undefined;
  rules: RestrictedRelationRules;
  /**
   * Called in walk order for every relation with a static target that a
   * populate's `filters` or `sort` follow and the rules let through, at any
   * populate and filter depth. Root filters and sort are not reported: the
   * core checks their grants itself (validateQuery's throwRestrictedRelations).
   */
  onPopulateQueryRelation?: (relation: PopulateQueryRelation) => void;
}

const POPULATABLE_TYPES = new Set(["relation", "media", "component", "dynamiczone"]);
const UPLOAD_FILE_UID = "plugin::upload.file";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const joinPath = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** True when `attr` of `source` may not be followed under `rules`. */
export function isRestrictedRelation(
  source: RelationModel | undefined,
  attr: RelationAttribute | undefined,
  rules: RestrictedRelationRules,
): boolean {
  if (!attr || attr.type !== "relation") return false;
  // No static target = morph relation: it may lead anywhere.
  if (!attr.target) return true;
  if (!Object.prototype.hasOwnProperty.call(rules, attr.target)) return false;
  // A source without a known uid cannot prove it is trusted.
  return !(source?.uid !== undefined && rules[attr.target].includes(source.uid));
}

/**
 * Applies the rules to a SANITIZED content-api query, i.e. the object the
 * controller hands to the service. Returns the query with every restricted
 * populate path dropped (a copy when populate is present); throws the core's
 * `Invalid key` ValidationError for a filter or sort path that crosses a
 * restricted relation. Every other key passes through untouched.
 */
export function guardRestrictedRelations(
  query: Record<string, unknown>,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
): Record<string, unknown> {
  // Root filters and sort: the core already checked their grants.
  assertFilters(query.filters, model, options, "", undefined);
  assertSort(query.sort, model, options, "", undefined);
  if (query.populate === undefined) return query;
  return { ...query, populate: stripPopulate(query.populate, model, options, "") };
}

/**
 * Removes restricted relations from a response entity (or an array of
 * them) in place, at any populated depth, and returns the same reference.
 * Data-bounded like stripSensitiveUserFields: it only descends into keys
 * present in `data`, and a WeakSet guards against shared/cyclic objects.
 */
export function stripRestrictedRelationsFromOutput<T>(
  data: T,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
): T {
  visitOutput(data, model, options, new WeakSet<object>());
  return data;
}

/**
 * The core's root rule, applied to the relations a populate's filters and
 * sort follow (batch 15.2, collected through `onPopulateQueryRelation`):
 * throws the core's `Invalid key` 400 for the first one, in walk order,
 * whose target the caller holds no `find` on. `canFind` is asked once per
 * target. A 400 rather than a dropped clause, as for the restricted
 * relations: the answer stays a function of the query shape alone.
 */
export async function assertPopulateQueryGrants(
  relations: readonly PopulateQueryRelation[],
  canFind: (target: string) => Promise<boolean>,
): Promise<void> {
  const decisions = new Map<string, boolean>();
  for (const { target, key, path } of relations) {
    let allowed = decisions.get(target);
    if (allowed === undefined) {
      allowed = await canFind(target);
      decisions.set(target, allowed);
    }
    if (!allowed) throwInvalidKey(key, path);
  }
}

/** Mirrors @strapi/utils validate/utils.js throwInvalidKey (same 400, same text). */
function throwInvalidKey(key: string, path: string): never {
  const message = path && path !== key ? `Invalid key ${key} at ${path}` : `Invalid key ${key}`;
  throw new errors.ValidationError(message, { key, path });
}

/** The model a populate/filter/sort below `attr` walks into (undefined = unknown). */
function nestedModel(
  attr: RelationAttribute,
  options: RestrictedRelationOptions,
): RelationModel | undefined {
  let uid: string | undefined;
  if (attr.type === "relation") uid = attr.target;
  else if (attr.type === "media") uid = UPLOAD_FILE_UID;
  else if (attr.type === "component") uid = attr.component;
  return uid ? options.getModel(uid) : undefined;
}

function ownsRestricted(model: RelationModel | undefined, options: RestrictedRelationOptions) {
  return Object.values(model?.attributes ?? {}).some((attr) =>
    isRestrictedRelation(model, attr, options.rules),
  );
}

function isPrivateAttribute(
  model: RelationModel | undefined,
  name: string,
  attr: RelationAttribute,
) {
  return attr.private === true || (model?.options?.privateAttributes ?? []).includes(name);
}

/**
 * The explicit, safe replacement for a `*` at `model`: its populatable
 * attributes minus the restricted and the private ones. Strapi adds the
 * private creator relations createdBy/updatedBy (→ admin::user) to every
 * content type at runtime (@strapi/core domain/content-type), and the core
 * never hands them out; naming them here would only fetch rows the output
 * sanitizer drops, or 400 wherever validateQuery sees the list (throwPrivate).
 */
function expandWildcard(model: RelationModel | undefined, options: RestrictedRelationOptions) {
  return Object.entries(model?.attributes ?? {})
    .filter(
      ([name, attr]) =>
        POPULATABLE_TYPES.has(attr.type ?? "") &&
        !isPrivateAttribute(model, name, attr) &&
        !attr.target?.startsWith("admin::") &&
        !isRestrictedRelation(model, attr, options.rules),
    )
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// filters and sort: reject
// ---------------------------------------------------------------------------

/** Receives the relations a populate's filters and sort follow; absent at the root. */
type RelationVisit = ((relation: PopulateQueryRelation) => void) | undefined;

/**
 * Rejects `attr` under the rules, else reports it to `visit` when it is a
 * relation with a static target (a morph relation has none and is
 * restricted anyway).
 */
function checkRelation(
  model: RelationModel | undefined,
  attr: RelationAttribute,
  options: RestrictedRelationOptions,
  key: string,
  at: string,
  visit: RelationVisit,
): void {
  if (isRestrictedRelation(model, attr, options.rules)) throwInvalidKey(key, at);
  if (visit && attr.type === "relation" && attr.target) {
    visit({ target: attr.target, key, path: at });
  }
}

function assertFilters(
  filters: unknown,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  path: string,
  visit: RelationVisit,
): void {
  if (Array.isArray(filters)) {
    for (const item of filters) assertFilters(item, model, options, path, visit);
    return;
  }
  if (!isPlainObject(filters)) return;
  for (const [key, value] of Object.entries(filters)) {
    const attr = model?.attributes?.[key];
    if (!attr) {
      // Operators ($and/$or/$not, but also value operators) and any other
      // non-attribute key: the core walks their operand on the SAME model
      // (@strapi/utils traverse/query-filters.js), so this walk does too.
      assertFilters(value, model, options, path, visit);
      continue;
    }
    const at = joinPath(path, key);
    checkRelation(model, attr, options, key, at, visit);
    const nested = nestedModel(attr, options);
    if (nested) assertFilters(value, nested, options, at, visit);
  }
}

function assertSort(
  sort: unknown,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  path: string,
  visit: RelationVisit,
): void {
  if (typeof sort === "string") {
    // "title:asc,teams.name:desc" — the order suffix is not part of the path.
    for (const token of sort.split(",")) {
      assertSortPath(token.split(":")[0].trim().split("."), model, options, path, visit);
    }
    return;
  }
  if (Array.isArray(sort)) {
    for (const item of sort) assertSort(item, model, options, path, visit);
    return;
  }
  if (!isPlainObject(sort)) return;
  // { title: "asc", teams: { name: "desc" } }
  for (const [key, value] of Object.entries(sort)) {
    const attr = model?.attributes?.[key];
    if (!attr) continue;
    const at = joinPath(path, key);
    checkRelation(model, attr, options, key, at, visit);
    const nested = nestedModel(attr, options);
    if (nested && typeof value !== "string") assertSort(value, nested, options, at, visit);
  }
}

function assertSortPath(
  segments: string[],
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  path: string,
  visit: RelationVisit,
): void {
  let current = model;
  let at = path;
  for (const segment of segments) {
    const attr = current?.attributes?.[segment];
    if (!attr) return;
    at = joinPath(at, segment);
    checkRelation(current, attr, options, segment, at, visit);
    current = nestedModel(attr, options);
  }
}

// ---------------------------------------------------------------------------
// populate: strip
// ---------------------------------------------------------------------------

/** Unchanged string values are returned as-is (same reference). */
function stripPopulate(
  value: unknown,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  path: string,
): unknown {
  if (typeof value === "string") {
    return stripPaths(value.split(","), model, options) ?? value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return stripPaths(item.split(","), model, options) ?? [item];
      return [isPlainObject(item) ? stripObject(item, model, options, path) : item];
    });
  }
  if (isPlainObject(value)) return stripObject(value, model, options, path);
  return value;
}

/**
 * Comma/array form. Returns the safe path list, or `null` when every path
 * was already safe (the caller then keeps the original value).
 */
function stripPaths(
  tokens: string[],
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
): string[] | null {
  const out: string[] = [];
  let changed = false;
  for (const token of tokens) {
    const path = token.trim();
    if (path === "*" && ownsRestricted(model, options)) {
      out.push(...expandWildcard(model, options));
      changed = true;
      continue;
    }
    const safe = safePath(path, model, options);
    if (safe !== path) changed = true;
    if (safe) out.push(safe);
  }
  return changed ? [...new Set(out)] : null;
}

/** Truncates a dotted path before its first restricted segment. */
function safePath(
  path: string,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
): string {
  const segments = path.split(".");
  const kept: string[] = [];
  let current = model;
  for (const [index, segment] of segments.entries()) {
    if (segment === "*") {
      if (!ownsRestricted(current, options)) kept.push(segment);
      break;
    }
    const attr = current?.attributes?.[segment];
    if (!attr) {
      // The core ignores unknown attributes, so nothing can be reached
      // through them — but only at the root is the model known for sure.
      if (index === 0 || current) kept.push(...segments.slice(index));
      break;
    }
    if (isRestrictedRelation(current, attr, options.rules)) break;
    kept.push(segment);
    current = nestedModel(attr, options);
  }
  return kept.join(".");
}

function stripObject(
  populate: Record<string, unknown>,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let wildcard = false;
  for (const [key, sub] of Object.entries(populate)) {
    if (key === "*") {
      if (ownsRestricted(model, options)) wildcard = true;
      else out[key] = sub;
      continue;
    }
    if (key.includes(".")) {
      // The core does not resolve dotted object keys today; keep one only
      // while it could not reach a restricted target if it ever did.
      if (safePath(key, model, options) === key) out[key] = sub;
      continue;
    }
    const attr = model?.attributes?.[key];
    if (!attr) {
      out[key] = sub;
      continue;
    }
    if (isRestrictedRelation(model, attr, options.rules)) continue;
    out[key] = stripNested(sub, attr, options, joinPath(path, key));
  }
  if (wildcard) {
    for (const name of expandWildcard(model, options)) if (!(name in out)) out[name] = true;
  }
  return out;
}

/** The value under one (non-restricted) attribute key. */
function stripNested(
  sub: unknown,
  attr: RelationAttribute,
  options: RestrictedRelationOptions,
  path: string,
): unknown {
  if (attr.type === "dynamiczone") return isPlainObject(sub) ? true : sub;
  const nested = nestedModel(attr, options);
  if (Array.isArray(sub)) return stripPopulate(sub, nested, options, path);
  if (!isPlainObject(sub)) return sub;
  // populate[teams][filters|sort] run against the NESTED model; the core
  // checks no grant there, so each relation they follow is reported.
  const visit = options.onPopulateQueryRelation;
  assertFilters(sub.filters, nested, options, path, visit);
  assertSort(sub.sort, nested, options, path, visit);
  if (!("populate" in sub)) return sub;
  return { ...sub, populate: stripPopulate(sub.populate, nested, options, path) };
}

// ---------------------------------------------------------------------------
// output: delete
// ---------------------------------------------------------------------------

function visitOutput(
  data: unknown,
  model: RelationModel | undefined,
  options: RestrictedRelationOptions,
  seen: WeakSet<object>,
): void {
  if (data === null || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const item of data) visitOutput(item, model, options, seen);
    return;
  }
  if (seen.has(data)) return;
  seen.add(data);

  const record = data as Record<string, unknown>;
  for (const [key, attr] of Object.entries(model?.attributes ?? {})) {
    if (!(key in record)) continue;
    // Also a populated count ({ count: n }) or a bare id: both disclose hidden rows.
    if (isRestrictedRelation(model, attr, options.rules)) {
      delete record[key];
      continue;
    }
    const value = record[key];
    if (value === null || typeof value !== "object") continue;
    if (attr.type === "dynamiczone") {
      for (const item of Array.isArray(value) ? value : [value]) {
        const component = isPlainObject(item) ? item.__component : undefined;
        if (typeof component === "string") {
          visitOutput(item, options.getModel(component), options, seen);
        }
      }
      continue;
    }
    const nested = nestedModel(attr, options);
    if (nested) visitOutput(value, nested, options, seen);
  }
}
