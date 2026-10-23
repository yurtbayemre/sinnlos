/**
 * Blocked people are hidden from the directory (v0.28, plan rev2 §1, M10).
 *
 * A blocked account is someone who left (or is about to be anonymised).
 * The content API answers as if they were gone from the directory:
 *   - `/api/users`, `/api/users/:id`, `/api/users/count` (the root of every
 *     query on the user model) see active users only; a hidden `:id` is a
 *     404 (extensions/users-permissions/strapi-server.ts);
 *   - the DIRECTORY relations (a user's manager and direct reports, a
 *     department's head and members, a team's lead and members) populate
 *     active users only, at any depth and in the count form too.
 * Everything else that points at a person (announcement author, comment
 * author, kudos from/to, event organiser, uploadedBy, …) keeps pointing at
 * them: attribution of retained content is the business record. Such a
 * populated user is cut to its attribution when blocked, by the output
 * sanitizer (utils/sanitize-user-contact.ts); this walk adds `blocked` to an
 * explicit `fields` list of a populated user relation so that cut always
 * knows.
 *
 * Applied by the sanitize.query wrapper (bootstrap/restricted-relation-guard.ts)
 * to the SANITIZED query, after validateQuery and the relation guard, for
 * every caller: the moderators' relation bypass does not open the directory.
 * The user-management API (admin) reads through db.query and still lists
 * blocked people.
 *
 * Populate shapes (@strapi/utils convert-query-params.js): a comma string, a
 * list of (dotted) paths, `*`, or an object whose values are `true`,
 * `"true"` or `{ fields, filters, populate, sort, count }`. A level that
 * reaches a directory relation, or a user relation with explicit `fields`,
 * is rewritten into the object form (the same query the core would build);
 * every other level is returned as it came (same reference).
 *
 * Pure: the schema comes in through `getModel` (see user-visibility.test.ts).
 */
import { USER_UID } from "./sanitize-user-contact";

/** The slice of a Strapi attribute the walk reads. */
interface Attribute {
  type?: string;
  target?: string;
  component?: string;
  private?: boolean;
}

/** The slice of a Strapi model the walk reads. */
export interface VisibilityModel {
  uid?: string;
  attributes?: Record<string, Attribute>;
  options?: { privateAttributes?: string[] };
}

export type GetModel = (uid: string) => VisibilityModel | undefined;

/** An active user: not blocked (NULL counts as not blocked, rows from before the default). */
export const ACTIVE_USER_FILTER = {
  $or: [{ blocked: false }, { blocked: { $null: true } }],
};

/** The relations that make up the directory, per source model. */
export const DIRECTORY_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  [USER_UID]: ["manager", "directReports"],
  "api::department.department": ["head", "members"],
  "api::team.team": ["lead", "members"],
};

const UPLOAD_FILE_UID = "plugin::upload.file";
const POPULATABLE = new Set(["relation", "media", "component", "dynamiczone"]);

type Row = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const andFilters = (filters: unknown, clause: Row): Row =>
  filters === undefined || filters === null ? clause : { $and: [filters, clause] };

const isDirectory = (model: VisibilityModel | undefined, key: string) =>
  model?.uid !== undefined && (DIRECTORY_RELATIONS[model.uid] ?? []).includes(key);

const hasDirectory = (model: VisibilityModel | undefined) =>
  model?.uid !== undefined && DIRECTORY_RELATIONS[model.uid] !== undefined;

function nestedModel(attr: Attribute, getModel: GetModel): VisibilityModel | undefined {
  if (attr.type === "relation" && attr.target) return getModel(attr.target);
  if (attr.type === "media") return getModel(UPLOAD_FILE_UID);
  if (attr.type === "component" && attr.component) return getModel(attr.component);
  return undefined;
}

/** What `*` populates at `model`: the populatable attributes, minus private and admin ones. */
function wildcard(model: VisibilityModel | undefined): string[] {
  const privates = model?.options?.privateAttributes ?? [];
  return Object.entries(model?.attributes ?? {})
    .filter(
      ([name, attr]) =>
        POPULATABLE.has(attr.type ?? "") &&
        attr.private !== true &&
        !privates.includes(name) &&
        !attr.target?.startsWith("admin::"),
    )
    .map(([name]) => name);
}

/** The path tokens of a string or list populate. */
function pathTokens(value: string | unknown[]): string[] {
  const items = typeof value === "string" ? [value] : value;
  return items.flatMap((item) =>
    typeof item === "string" ? item.split(",").map((token) => token.trim()) : [],
  );
}

/** Whether a dotted path (or `*`) at `model` reaches a directory relation. */
function pathNeeds(path: string, model: VisibilityModel | undefined, getModel: GetModel): boolean {
  let current = model;
  for (const segment of path.split(".")) {
    if (segment === "*") return hasDirectory(current);
    const attr = current?.attributes?.[segment];
    if (!attr) return false;
    if (attr.type === "relation" && attr.target === USER_UID && isDirectory(current, segment)) {
      return true;
    }
    current = nestedModel(attr, getModel);
  }
  return false;
}

/** Whether a populate value at `model` needs rewriting anywhere below. */
function needs(value: unknown, model: VisibilityModel | undefined, getModel: GetModel): boolean {
  if (typeof value === "string" || Array.isArray(value)) {
    if (pathTokens(value).some((path) => pathNeeds(path, model, getModel))) return true;
    return Array.isArray(value) && value.some((item) => isPlainObject(item) && needs(item, model, getModel));
  }
  if (!isPlainObject(value)) return false;
  for (const [key, sub] of Object.entries(value)) {
    if (key === "*") {
      if (hasDirectory(model)) return true;
      continue;
    }
    const attr = model?.attributes?.[key];
    if (!attr) continue;
    if (attr.type === "relation" && attr.target === USER_UID) {
      if (isDirectory(model, key)) return true;
      if (isPlainObject(sub) && sub.fields !== undefined) return true;
    }
    if (isPlainObject(sub) && sub.populate !== undefined) {
      if (needs(sub.populate, nestedModel(attr, getModel), getModel)) return true;
    }
  }
  return false;
}

/** Merges two populate entries of one key: an object beats `true`, nested populates merge. */
function mergeEntry(a: unknown, b: unknown): unknown {
  if (!isPlainObject(a)) return isPlainObject(b) ? b : true;
  if (!isPlainObject(b)) return a;
  const populate =
    a.populate !== undefined && b.populate !== undefined
      ? mergeObjects(toObject(a.populate), toObject(b.populate))
      : (a.populate ?? b.populate);
  return { ...a, ...b, ...(populate !== undefined ? { populate } : {}) };
}

function mergeObjects(a: Row, b: Row): Row {
  const out: Row = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = key in out ? mergeEntry(out[key], value) : value;
  }
  return out;
}

/** One populate level in the object form; `*` is kept as a key for the walk to expand. */
function toObject(value: unknown): Row {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" && !Array.isArray(value)) return {};
  let out: Row = {};
  for (const path of pathTokens(value)) {
    if (path === "") continue;
    const [head, ...rest] = path.split(".");
    const entry = rest.length > 0 ? { populate: rest.join(".") } : true;
    out = mergeObjects(out, { [head]: entry });
  }
  if (Array.isArray(value)) {
    for (const item of value) if (isPlainObject(item)) out = mergeObjects(out, item);
  }
  return out;
}

/** Adds `blocked` to an explicit field list (`*` already holds it). */
function withBlocked(fields: unknown): unknown {
  if (fields === "*") return fields;
  const list =
    typeof fields === "string"
      ? fields.split(",").map((field) => field.trim())
      : Array.isArray(fields)
        ? fields
        : null;
  if (list === null || list.includes("*") || list.includes("blocked")) return fields;
  return [...list, "blocked"];
}

function rewrite(value: unknown, model: VisibilityModel | undefined, getModel: GetModel): unknown {
  if (!needs(value, model, getModel)) return value;
  const level = toObject(value);
  const out: Row = {};
  const entries = Object.entries(level);
  for (const [key, sub] of entries) {
    if (key !== "*") out[key] = sub;
  }
  if ("*" in level) {
    for (const name of wildcard(model)) if (!(name in out)) out[name] = true;
  }
  for (const [key, sub] of Object.entries(out)) {
    const attr = model?.attributes?.[key];
    if (!attr) continue;
    let next: unknown = sub;
    if (attr.type === "relation" && attr.target === USER_UID) {
      const directory = isDirectory(model, key);
      const fields = isPlainObject(sub) ? sub.fields : undefined;
      if (directory || fields !== undefined) {
        const entry: Row = isPlainObject(sub) ? { ...sub } : {};
        if (directory) entry.filters = andFilters(entry.filters, ACTIVE_USER_FILTER);
        if (fields !== undefined) entry.fields = withBlocked(fields);
        next = entry;
      }
    }
    if (isPlainObject(next) && next.populate !== undefined) {
      next = { ...next, populate: rewrite(next.populate, nestedModel(attr, getModel), getModel) };
    }
    out[key] = next;
  }
  return out;
}

/**
 * The sanitized content-API query with blocked people hidden from the
 * directory: the root filter on the user model, the directory relations'
 * populate filter, `blocked` in explicit user `fields`. Returns the query
 * itself when nothing applies.
 */
export function hideBlockedUsers(
  query: Row,
  model: VisibilityModel | undefined,
  getModel: GetModel,
): Row {
  let out = query;
  if (model?.uid === USER_UID) {
    out = { ...out, filters: andFilters(out.filters, ACTIVE_USER_FILTER) };
  }
  if (out.populate !== undefined) {
    const populate = rewrite(out.populate, model, getModel);
    if (populate !== out.populate) out = { ...out, populate };
  }
  return out;
}
