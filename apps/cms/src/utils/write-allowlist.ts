import { errors } from "@strapi/utils";

/**
 * Field-level write allowlists for content-API writes (FX07).
 *
 * Why: the write policies used to be ROW gates only. Once a caller passed
 * them (a department head on their department, a team lead or member on
 * their team, the author of a wiki page, any non-guest creating a page),
 * the core controller took every attribute from the payload. That let them
 * re-link rows they do not own: `pages`, `members` and `lead` on a team,
 * `pages`/`teams`/`members`/`head` on a department, and `space`, `parent`,
 * `children`, `revisions`, `author`, `department`, `team` on a wiki page.
 * The relation guard (restricted-relations.ts) TRUSTS wiki-page.parent/
 * children, wiki-space.pages and wiki-revision.page to stay inside one
 * wiki space, so a cross-space link written here was readable through them.
 *
 * The model is declarative so frontend authoring (v2) can extend it:
 *   content type → write action → ROLE CLASS → allowed fields.
 * A role class is the caller's relation to the row being written ("head"
 * of this department, "lead" of this team, "author" of this page, ...).
 * The route's write policy decides the row gate and the class, then calls
 * enforceWriteAllowlist() once. That is the only place the payload is
 * checked for that route.
 *
 * For callers WITHOUT a bypass role (admin_role/editor are unchanged):
 *   - every payload key must be listed for the caller's class, otherwise the
 *     request fails with ONE generic 400 naming the offending keys. That
 *     includes inverse sides (members, teams, pages, children, revisions),
 *     ownership and placement (author, lastEditor, head, lead, department,
 *     team), media (headerImage, avatar: set in the admin panel for now),
 *     and Strapi's own keys (id, documentId, publishedAt, locale, ...).
 *   - a listed value must pass its check. The same message covers a bad
 *     value, so it never says WHY an id was refused: a missing, hidden,
 *     draft-only or wrong-space target answers exactly like any other
 *     invalid value (no existence oracle).
 *   - relation fields accept every Strapi input shape for a to-one relation
 *     (raw id, numeric string, documentId, {id}, {documentId}, arrays,
 *     {set}, {connect}, {disconnect}, null), are resolved by a named check
 *     the policy supplies, and are rewritten to `{ set: [{ documentId }] }`
 *     (or null / `{ disconnect: [...] }`), so Strapi resolves exactly the
 *     documents that were checked. Draft & publish references go by
 *     documentId, never by row id (publish is delete + recreate).
 *   - `callerFields` are set to the caller's user id after the check; the
 *     payload itself may not name them.
 *
 * Pure: no Strapi runtime. The relation checks come in from the enforcing
 * policy, so this module is unit testable on its own
 * (write-allowlist.test.ts).
 */

export const DEPARTMENT_UID = "api::department.department";
export const TEAM_UID = "api::team.team";
export const WIKI_PAGE_UID = "api::wiki-page.wiki-page";

/** Roles that skip the allowlist entirely (they also author in the admin panel). */
export const WRITE_BYPASS_ROLES: readonly string[] = ["admin_role", "editor"];

export const isWriteBypassRole = (roleType: unknown): boolean =>
  typeof roleType === "string" && WRITE_BYPASS_ROLES.includes(roleType);

export type WriteAction = "create" | "update";

export type ValueCheck = (value: unknown) => boolean;

/** A schema attribute stored as sent, after `check` accepted it. */
export interface ValueField {
  kind: "value";
  check: ValueCheck;
}

/**
 * Not a schema attribute: the route's controller consumes it before the
 * core sees the payload (wiki-page `revisionSummary`).
 */
export interface ControllerField {
  kind: "controller";
  check: ValueCheck;
}

/** Names of the async relation checks a policy can supply. */
export type RelationCheckName = "wikiSpace" | "wikiParent";

/** A to-one relation, resolved and authorized by a named async check. */
export interface RelationField {
  kind: "relation";
  check: RelationCheckName;
  /** The payload must name exactly one target (no clear, no disconnect). */
  required?: boolean;
}

export type FieldSpec = ValueField | ControllerField | RelationField;

export interface WriteRule {
  /**
   * The only keys a payload may carry. Relation checks run in THIS order,
   * so a check can rely on an earlier relation (wiki `parent` on create
   * needs the `space` resolved first).
   */
  fields: Readonly<Record<string, FieldSpec>>;
  /** Attributes set to the caller's user id; the payload may not name them. */
  callerFields?: readonly string[];
}

export type WriteAllowlist = Readonly<
  Record<string, Partial<Record<WriteAction, Readonly<Record<string, WriteRule>>>>>
>;

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

/** Strapi `string` and `uid` attributes are varchar(255) columns on Postgres. */
const MAX_STRING_LENGTH = 255;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 100;

const isString = (value: unknown): value is string => typeof value === "string";

export const valueChecks = {
  /** A non-blank `string` attribute. */
  requiredString: (value: unknown) =>
    isString(value) && value.trim().length > 0 && value.length <= MAX_STRING_LENGTH,
  /**
   * A `uid` attribute: the character set Strapi's own uid validator enforces,
   * which it skips for drafts (content-API writes create drafts).
   */
  uid: (value: unknown) =>
    isString(value) && value.length <= MAX_STRING_LENGTH && /^[A-Za-z0-9\-_.~]+$/.test(value),
  /** `text` / `richtext`: any string, or null to clear. */
  nullableText: (value: unknown) => value === null || isString(value),
  boolean: (value: unknown) => typeof value === "boolean",
  /** `integer` attributes are int4 columns. */
  int32: (value: unknown) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= INT32_MIN &&
    value <= INT32_MAX,
  /**
   * `#rrggbb` only: the web appends a two-digit alpha suffix to the stored
   * value (departments list gradient), so the short and alpha forms would
   * render as invalid CSS. Anything else (named colours, url(), ...) is out.
   */
  hexColor: (value: unknown) => isString(value) && /^#[0-9a-fA-F]{6}$/.test(value),
  /** The `json` tags attribute, restricted to a short list of short strings. */
  tags: (value: unknown) =>
    value === null ||
    (Array.isArray(value) &&
      value.length <= MAX_TAGS &&
      value.every(
        (tag: unknown) => isString(tag) && tag.trim().length > 0 && tag.length <= MAX_TAG_LENGTH,
      )),
} satisfies Record<string, ValueCheck>;

const value = (check: ValueCheck): ValueField => ({ kind: "value", check });
const toOne = (check: RelationCheckName, options: { required?: boolean } = {}): RelationField => ({
  kind: "relation",
  check,
  ...options,
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

/** Wiki page content a non-privileged author may write. */
const WIKI_PAGE_CONTENT = {
  title: value(valueChecks.requiredString),
  slug: value(valueChecks.uid),
  body: value(valueChecks.nullableText),
  summary: value(valueChecks.nullableText),
  tags: value(valueChecks.tags),
  tocEnabled: value(valueChecks.boolean),
  order: value(valueChecks.int32),
};

/**
 * Updating a page. `space` is create-only: moving a page between spaces is
 * an admin/editor action. `parent` must be a visible page of the page's own
 * space (never the page itself or one of its descendants).
 */
const WIKI_PAGE_EDIT: WriteRule = {
  fields: {
    ...WIKI_PAGE_CONTENT,
    parent: toOne("wikiParent"),
    // Stripped and handed to the revision lifecycle by the controller.
    revisionSummary: { kind: "controller", check: valueChecks.nullableText },
  },
};

/**
 * Team rows: `description` only. `members` and `lead` are NOT writable by
 * any non-bypass class: membership decides who reads the team's wiki space
 * (visible-ids.ts) and who is in an announcement audience, and `lead`
 * grants edit rights on the team's pages, so both stay admin-managed (admin
 * panel, later the planned Entra directory sync). A plain member of the
 * team has no class here at all, so it cannot write the team. Media
 * (`avatar`) is admin-panel only.
 */
const TEAM_EDIT: WriteRule = {
  fields: { description: value(valueChecks.nullableText) },
};

export const WRITE_ALLOWLIST = {
  [DEPARTMENT_UID]: {
    update: {
      // department_head whose own department this is. `name` stays with
      // admin/editor: the planned Entra department sync matches on it.
      head: {
        fields: {
          description: value(valueChecks.nullableText),
          color: value(valueChecks.hexColor),
        },
      },
    },
  },
  [TEAM_UID]: {
    update: {
      lead: TEAM_EDIT,
      // department_head of the team's department: same rights as the lead.
      departmentHead: TEAM_EDIT,
    },
  },
  [WIKI_PAGE_UID]: {
    create: {
      // Any non-guest holding the create grant (department_head, team_lead).
      // `space` must be a space the caller can READ, `parent` a readable page
      // of that space. Visibility, not a separate edit right, is the bar:
      // the schema has no per-space editor list, a new page only lands where
      // its author can already read (so none of its relations reaches a
      // hidden row), and what a page says in a shared space is a moderation
      // matter (admins and editors delete pages).
      author: {
        fields: {
          ...WIKI_PAGE_CONTENT,
          space: toOne("wikiSpace", { required: true }),
          parent: toOne("wikiParent"),
        },
        callerFields: ["author", "lastEditor"],
      },
    },
    update: {
      // can-edit-wiki's row gate: page author, head of the page's
      // department, lead of the page's team. lastEditor is forced by the
      // wiki-page controller for every caller.
      author: WIKI_PAGE_EDIT,
      departmentHead: WIKI_PAGE_EDIT,
      teamLead: WIKI_PAGE_EDIT,
    },
  },
} as const satisfies WriteAllowlist;

/** The rule for a caller's class, or undefined when the class may not write. */
export function writeRuleFor(
  uid: string,
  action: WriteAction,
  roleClass: string,
): WriteRule | undefined {
  const byClass = (WRITE_ALLOWLIST as WriteAllowlist)[uid]?.[action];
  return byClass && hasOwn(byClass, roleClass) ? byClass[roleClass] : undefined;
}

// ---------------------------------------------------------------------------
// Relation input
// ---------------------------------------------------------------------------

export type RelationRef = { id: number } | { documentId: string };

/** A to-one relation payload, reduced to what it would do. */
export interface ToOneRelationInput {
  /** The row it should point at afterwards: null = clear, undefined = unchanged. */
  target: RelationRef | null | undefined;
  /** Rows named for disconnection only. */
  disconnect: RelationRef[];
}

/** The same, after a check resolved and authorized every row to a documentId. */
export interface ResolvedToOne {
  target: string | null | undefined;
  disconnect: string[];
}

/**
 * Resolves and authorizes every row a relation input names. Returns null to
 * refuse the field (with the generic message). `resolved` holds the relation
 * fields checked before this one, in rule order.
 */
export type RelationCheck = (
  input: ToOneRelationInput,
  resolved: Readonly<Record<string, ResolvedToOne>>,
) => Promise<ResolvedToOne | null>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOwn<T extends object>(object: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Strapi resolves a string by `parseInt` (map-relation.js isNumeric): "12"
 * and "12abc" both become row ids. Only canonical forms are accepted here:
 * a positive decimal id, or a documentId that parseInt cannot read as a
 * number (Strapi's generated documentIds start with a letter).
 */
const NUMERIC_ID = /^[1-9]\d{0,15}$/;
const DOCUMENT_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function parseId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (isString(value) && NUMERIC_ID.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

function parseRef(value: unknown): RelationRef | null {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    // Longhand: exactly one of id/documentId. position, locale, status,
    // __type ... have no meaning on these relations and are refused.
    if (keys.length !== 1) return null;
    if (keys[0] === "id") {
      const id = parseId(value.id);
      return id === null ? null : { id };
    }
    if (keys[0] === "documentId") {
      return isString(value.documentId) && DOCUMENT_ID.test(value.documentId)
        ? { documentId: value.documentId }
        : null;
    }
    return null;
  }
  const id = parseId(value);
  if (id !== null) return { id };
  return isString(value) && DOCUMENT_ID.test(value) ? { documentId: value } : null;
}

/** A single ref or a flat array of refs (Strapi's `toArray`). */
function parseRefList(value: unknown): RelationRef[] | null {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const refs: RelationRef[] = [];
  for (const item of items) {
    const ref = parseRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

/** set semantics: at most one row, none = clear. */
function fromSet(value: unknown): ToOneRelationInput | null {
  const refs = parseRefList(value);
  if (!refs || refs.length > 1) return null;
  return { target: refs[0] ?? null, disconnect: [] };
}

/**
 * Parses every input shape Strapi accepts for a to-one relation
 * (@strapi/core document-service map-relation.js, @strapi/database
 * entity-manager toAssocs). Returns null for anything malformed or
 * ambiguous: more than one target, `set` mixed with connect/disconnect,
 * `{ set: null }` (a silent no-op in Strapi), nested arrays, unknown keys.
 */
export function parseToOneRelation(value: unknown): ToOneRelationInput | null {
  if (value === null) return { target: null, disconnect: [] };
  if (Array.isArray(value)) return fromSet(value);
  if (isPlainObject(value) && !hasOwn(value, "id") && !hasOwn(value, "documentId")) {
    const keys = Object.keys(value);
    if (keys.includes("set")) return keys.length === 1 ? fromSet(value.set) : null;
    if (keys.length === 0 || keys.some((key) => key !== "connect" && key !== "disconnect")) {
      return null;
    }
    const connect = hasOwn(value, "connect") ? parseRefList(value.connect) : [];
    const disconnect = hasOwn(value, "disconnect") ? parseRefList(value.disconnect) : [];
    if (!connect || !disconnect || connect.length > 1) return null;
    return { target: connect[0], disconnect };
  }
  const ref = parseRef(value);
  return ref ? { target: ref, disconnect: [] } : null;
}

/** Marker: the field is a no-op and is left out of the payload. */
const OMIT = Symbol("omit");

/** Back to a Strapi relation payload that names documents only. */
function toStrapiRelation(resolved: ResolvedToOne): unknown {
  if (resolved.target === null) return null;
  if (resolved.target !== undefined) return { set: [{ documentId: resolved.target }] };
  if (resolved.disconnect.length > 0) {
    return { disconnect: resolved.disconnect.map((documentId) => ({ documentId })) };
  }
  return OMIT;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/** The core controller's own message for a missing or non-object `data`. */
export const MISSING_DATA_MESSAGE = 'Missing "data" payload in the request body';

/** The one message for every refused key or value. */
export function writeAllowlistMessage(keys: readonly string[]): string {
  return `Invalid or disallowed data field(s): ${keys.join(", ")}`;
}

function refuse(keys: Iterable<string>): never {
  const sorted = [...new Set(keys)].sort();
  throw new errors.ValidationError(writeAllowlistMessage(sorted), { keys: sorted });
}

export interface WriteRuleEnvironment {
  callerId: number;
  relationChecks?: Readonly<Partial<Record<RelationCheckName, RelationCheck>>>;
}

/**
 * Checks `data` against `rule` and returns the payload to hand to the core:
 * the accepted values, the rewritten relations and the caller fields.
 * Throws a ValidationError (400) naming every refused key. Keys and plain
 * values are checked before any relation is looked up, so a refused key
 * never costs (or reveals) a database lookup.
 */
export async function applyWriteRule(
  data: unknown,
  rule: WriteRule,
  env: WriteRuleEnvironment,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(data)) throw new errors.ValidationError(MISSING_DATA_MESSAGE);

  const refused = new Set<string>();
  const out: Record<string, unknown> = {};
  const relationInputs = new Map<string, ToOneRelationInput>();

  for (const [key, raw] of Object.entries(data)) {
    const spec = hasOwn(rule.fields, key) ? rule.fields[key] : undefined;
    if (!spec) {
      refused.add(key);
    } else if (spec.kind === "relation") {
      const parsed = parseToOneRelation(raw);
      const singleTarget = parsed?.target != null && parsed.disconnect.length === 0;
      if (!parsed || (spec.required && !singleTarget)) refused.add(key);
      else relationInputs.set(key, parsed);
    } else if (spec.check(raw)) {
      out[key] = raw;
    } else {
      refused.add(key);
    }
  }
  for (const [key, spec] of Object.entries(rule.fields)) {
    if (spec.kind === "relation" && spec.required && !hasOwn(data, key)) refused.add(key);
  }
  if (refused.size > 0) refuse(refused);

  const resolved: Record<string, ResolvedToOne> = {};
  for (const [key, spec] of Object.entries(rule.fields)) {
    const input = relationInputs.get(key);
    if (spec.kind !== "relation" || !input) continue;
    const check = env.relationChecks?.[spec.check];
    // A rule naming a check its policy does not supply is a wiring bug:
    // fail the request (500) instead of writing an unchecked relation.
    if (!check) throw new Error(`write allowlist: relation check "${spec.check}" not supplied`);
    const result = await check(input, resolved);
    if (!result) refuse([key]);
    resolved[key] = result;
    const payload = toStrapiRelation(result);
    if (payload !== OMIT) out[key] = payload;
  }

  for (const field of rule.callerFields ?? []) out[field] = env.callerId;
  return out;
}

/** The slice of the Strapi policy context the enforcement reads and writes. */
export interface WritePolicyContext {
  request?: { body?: unknown };
}

/**
 * The single enforcement point for a write route: looks up the rule for
 * the caller's class, checks `request.body.data` and replaces it with the
 * sanitized payload. Resolves false when the class has no rule (the policy
 * returns that, i.e. 403); throws a ValidationError (400) on a refused
 * payload; resolves true otherwise. Call it only AFTER the row gate and
 * never for bypass roles.
 */
export async function enforceWriteAllowlist(
  policyContext: WritePolicyContext,
  target: { uid: string; action: WriteAction; roleClass: string },
  env: WriteRuleEnvironment,
): Promise<boolean> {
  const rule = writeRuleFor(target.uid, target.action, target.roleClass);
  if (!rule) return false;
  const body = policyContext.request?.body;
  if (!isPlainObject(body)) throw new errors.ValidationError(MISSING_DATA_MESSAGE);
  body.data = await applyWriteRule(body.data, rule, env);
  return true;
}

// ---------------------------------------------------------------------------
// What the write policies share
// ---------------------------------------------------------------------------

export const USER_UID = "plugin::users-permissions.user";

/** The authenticated caller as users-permissions puts it on ctx.state. */
export interface WriteCaller {
  id: number;
  role?: { type?: string } | null;
}

/** The slice of the Strapi policy context a write policy reads and writes. */
export interface WritePolicy extends WritePolicyContext {
  state?: { user?: WriteCaller | null };
  params?: { id?: unknown };
}

/** The slice of `strapi` the write policies and their checks use. */
export interface StrapiDbQuery {
  findOne(params: object): Promise<unknown>;
  findMany(params: object): Promise<unknown>;
}

export interface StrapiDb {
  db: { query(uid: string): StrapiDbQuery };
}

/**
 * The `where` for the row a write route targets. v5 routes carry a
 * documentId; a numeric id is accepted too so direct API consumers keep
 * working (same gotcha as in the comment controller). null = no target.
 */
export function targetRowWhere(idParam: unknown): { id: number } | { documentId: string } | null {
  if (idParam === undefined || idParam === null || idParam === "") return null;
  const value = String(idParam);
  return /^\d+$/.test(value) ? { id: Number(value) } : { documentId: value };
}
