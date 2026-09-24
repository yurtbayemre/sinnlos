import type { ModelSchema } from "./sanitize-user-contact";

/**
 * Removes every populate path that could reach a restricted content type
 * from a client-supplied `populate` query param (FX05).
 *
 * Why: the read-filter policies (wiki-visibility, ...) narrow only the ROOT
 * query of their own route. A type readable WITHOUT that filter hands the
 * filtered rows out as a populated relation: `department.pages` and
 * `team.pages` (inverse sides of wiki-page.department/team) returned the
 * pages of every wiki space — including spaces the caller may not see — to
 * any role holding department/team.find. Filters would be the wrong tool:
 * `populate` is validated WITHOUT auth (@strapi/utils 5.49
 * validate/index.js), so rewriting it never turns into a 400, while a
 * relational filter would.
 *
 * Model-aware and deep, because the side channel is not only one level
 * away: `teams.pages` on a department, `department.pages` on a team or
 * `members.department.pages` (the user schema links department AND teams)
 * reach the same rows. Every shape the core accepts is handled
 * (@strapi/utils convert-query-params.js, @strapi/database
 * populate/process.js):
 *   - object `{ pages: "true" }`, `{ pages: { populate: ... } }`, counts —
 *     the restricted key is dropped with everything nested under it,
 *   - string `"a,b"` and string arrays, including dotted paths `"teams.pages"`
 *     (truncated to the safe prefix `"teams"`),
 *   - the `*` wildcard — as the whole value (`populate=*`), inside an array
 *     (`populate[0]=*`), as an object key or as `populate[x][populate]=*`
 *     (the core resets the depth there, so a nested `*` means "every relation
 *     of x"). A wildcard at a model that owns a restricted relation is
 *     expanded into the explicit list of its other populatable attributes.
 *
 * Fail-closed choices: a relation WITHOUT a static target (morph relations,
 * e.g. the upload file's `related`) counts as restricted — it can point at
 * anything. Dynamic-zone populate objects collapse to `true` (no dynamic
 * zones exist in this schema; the component fragments could otherwise hide
 * a restricted relation). A dotted path that walks into an unresolvable
 * model is truncated there.
 *
 * Pure: the schema comes in through `getModel`, so it is unit testable
 * without Strapi (see restricted-populate.test.ts).
 */

export interface RestrictedPopulateOptions {
  /** Resolve a model uid to its schema (strapi.getModel); may return undefined. */
  getModel: (uid: string) => ModelSchema | undefined;
  /** Content-type uids no populate path may reach. */
  restrictedTargets: ReadonlySet<string>;
}

type Attribute = NonNullable<ModelSchema["attributes"]>[string];

const POPULATABLE_TYPES = new Set(["relation", "media", "component", "dynamiczone"]);
const UPLOAD_FILE_UID = "plugin::upload.file";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns the populate value with every path into a restricted target
 * removed. Unchanged string values are returned as-is (same reference), so
 * a harmless populate is never reshaped.
 */
export function stripRestrictedPopulate(
  populate: unknown,
  uid: string,
  options: RestrictedPopulateOptions,
): unknown {
  return strip(populate, options.getModel(uid), options);
}

function isRestricted(attr: Attribute | undefined, options: RestrictedPopulateOptions): boolean {
  if (!attr || attr.type !== "relation") return false;
  // No static target = morph relation: it may lead anywhere.
  return !attr.target || options.restrictedTargets.has(attr.target);
}

/** The model a populate below `attr` walks into (undefined = unknown). */
function nestedModel(attr: Attribute, options: RestrictedPopulateOptions): ModelSchema | undefined {
  let uid: string | undefined;
  if (attr.type === "relation") uid = attr.target;
  else if (attr.type === "media") uid = UPLOAD_FILE_UID;
  else if (attr.type === "component") uid = attr.component;
  return uid ? options.getModel(uid) : undefined;
}

function ownsRestricted(model: ModelSchema | undefined, options: RestrictedPopulateOptions) {
  return Object.values(model?.attributes ?? {}).some((attr) => isRestricted(attr, options));
}

/** The explicit, safe replacement for a `*` at `model`. */
function expandWildcard(model: ModelSchema | undefined, options: RestrictedPopulateOptions) {
  return Object.entries(model?.attributes ?? {})
    .filter(([, attr]) => POPULATABLE_TYPES.has(attr.type ?? "") && !isRestricted(attr, options))
    .map(([name]) => name);
}

function strip(
  value: unknown,
  model: ModelSchema | undefined,
  options: RestrictedPopulateOptions,
): unknown {
  if (typeof value === "string") {
    const paths = stripPaths(value.split(","), model, options);
    return paths ?? value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return stripPaths(item.split(","), model, options) ?? [item];
      return [isPlainObject(item) ? stripObject(item, model, options) : item];
    });
  }
  if (isPlainObject(value)) return stripObject(value, model, options);
  return value;
}

/**
 * Comma/array form. Returns the safe path list, or `null` when every path
 * was already safe (the caller then keeps the original value).
 */
function stripPaths(
  tokens: string[],
  model: ModelSchema | undefined,
  options: RestrictedPopulateOptions,
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
  model: ModelSchema | undefined,
  options: RestrictedPopulateOptions,
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
    if (isRestricted(attr, options)) break;
    kept.push(segment);
    current = nestedModel(attr, options);
  }
  return kept.join(".");
}

function stripObject(
  populate: Record<string, unknown>,
  model: ModelSchema | undefined,
  options: RestrictedPopulateOptions,
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
    if (isRestricted(attr, options)) continue;
    out[key] = stripNested(sub, attr, options);
  }
  if (wildcard) {
    for (const name of expandWildcard(model, options)) if (!(name in out)) out[name] = true;
  }
  return out;
}

/** The value under one (non-restricted) attribute key. */
function stripNested(sub: unknown, attr: Attribute, options: RestrictedPopulateOptions): unknown {
  if (attr.type === "dynamiczone") return isPlainObject(sub) ? true : sub;
  if (Array.isArray(sub)) return strip(sub, nestedModel(attr, options), options);
  if (!isPlainObject(sub) || !("populate" in sub)) return sub;
  return { ...sub, populate: strip(sub.populate, nestedModel(attr, options), options) };
}
