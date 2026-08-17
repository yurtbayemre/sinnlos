/**
 * Role-aware stripping of employee contact fields from content-api output
 * (GitHub issue #10 / P1.2 — "guests can read staff contact data").
 *
 * Pure, no Strapi runtime: `index.ts` registers a `content-api.output`
 * sanitizer factory that reads the caller's role from the request context
 * and, for a non-privileged caller, hands the response entity to
 * `stripSensitiveUserFields`. The security decision (`shouldSanitizeForRole`)
 * and the field removal are therefore unit-testable without a running
 * Strapi (see `sanitize-user-contact.test.ts`).
 *
 * WHY output-side + role-aware, and not the two obvious alternatives:
 *   - Revoking `plugin::users-permissions.user.find` from `guest` is NOT an
 *     option: Strapi runs validateQuery → throwRestrictedRelations BEFORE
 *     sanitizeQuery, so every guest read that POPULATES or FILTERS a user
 *     relation (author, uploadedBy, organizer, actor, manager, the
 *     notification/poll-vote visibility filters …) would 400. Guest keeps
 *     user.find; the fix is purely on the OUTPUT.
 *   - Marking the fields schema-`private` is NOT an option either: `private`
 *     is absolute and role-independent — it would also hide email/phone/
 *     hireDate from the member+ directory (/api/users, /people/[id]), and
 *     email is required + the login identifier + a search filter.
 * See docs/architecture.md §7b P1.2 for the full record.
 *
 * The sanitizer runs as the LAST content-api output transform: after
 * validateQuery/sanitizeQuery (so it never triggers throwRestrictedRelations)
 * and after the core sanitizers (private/restricted-relation removal). It
 * covers BOTH the directory itself (/api/users*, /api/users/me) AND every
 * populated user relation inside any content type.
 */

/** UID of the users-permissions user model. */
export const USER_UID = "plugin::users-permissions.user";

/**
 * User fields a non-privileged caller must never see.
 *
 * #10's acceptance criteria name email/phone/hireDate explicitly. We
 * deliberately strip two more fields that leak through the exact same
 * populate paths and carry no value for a read-only guest:
 *   - `officeLocation` — part of the physical contact card;
 *   - `microsoftOid`   — the internal Entra object id. It is `unique` but
 *     NOT schema-`private`, so it leaks through populate just like the rest;
 *     it is an internal identifier, never a guest-facing display field.
 * `birthday`/`birthdayVisible` are already schema-`private` and never reach
 * REST output, so they are intentionally NOT listed here.
 */
export const SENSITIVE_USER_FIELDS = [
  "email",
  "phone",
  "hireDate",
  "officeLocation",
  "microsoftOid",
] as const;

/**
 * The employee roles that MAY read the fields above. Fail-closed: only a
 * caller whose `role.type` is in this set keeps the fields; `guest`, the
 * pre-role-mapping `authenticated` fallback, anonymous `public`, and any
 * unknown/undefined role are sanitized.
 *
 * The exact type strings are the ones seeded in `src/index.ts` — note the
 * admin role is `admin_role`, not `admin`.
 */
export const PRIVILEGED_ROLE_TYPES: ReadonlySet<string> = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
]);

/** True when a caller with this `role.type` must have the fields stripped. */
export function shouldSanitizeForRole(roleType: string | null | undefined): boolean {
  return !(typeof roleType === "string" && PRIVILEGED_ROLE_TYPES.has(roleType));
}

/** The slice of a Strapi attribute definition the recursion depends on. */
interface AttributeSchema {
  type?: string;
  /** relation target uid */
  target?: string;
  /** component uid */
  component?: string;
}

/** The slice of a Strapi model definition the recursion depends on. */
export interface ModelSchema {
  uid?: string;
  attributes?: Record<string, AttributeSchema>;
}

export interface StripOptions {
  /** Resolve a model uid to its schema; may return undefined for unknowns. */
  getModel: (uid: string) => ModelSchema | undefined;
}

/**
 * Remove the sensitive user fields from `data` in place, descending through
 * relations / components / dynamic zones so that POPULATED user relations
 * (announcement.author, document.uploadedBy, event.organizer,
 * notification.actor, comment/reaction author, user.manager,
 * user.directReports, team.members, …) are cleaned too — at any depth.
 *
 * Schema-guided but data-bounded: it only ever descends into keys that are
 * actually present in `data`, so the recursion is bounded by the (finite)
 * populate depth of the response, not by the (cyclic) schema graph. A
 * WeakSet additionally guards against a pathological shared/cyclic object.
 *
 * Defensive by construction: null, scalars, missing schema, and unresolved
 * target models are passed through untouched — it never throws on a
 * partially-shaped payload. Returns the same (mutated) reference.
 */
export function stripSensitiveUserFields<T>(
  data: T,
  schema: ModelSchema | undefined,
  options: StripOptions,
): T {
  visit(data, schema, options, new WeakSet<object>());
  return data;
}

function visit(
  data: unknown,
  schema: ModelSchema | undefined,
  options: StripOptions,
  seen: WeakSet<object>,
): void {
  if (data === null || typeof data !== "object") return; // null / undefined / scalar

  if (Array.isArray(data)) {
    // Every element of a relation array shares the same target model.
    for (const item of data) visit(item, schema, options, seen);
    return;
  }

  if (seen.has(data)) return;
  seen.add(data);

  if (!schema || typeof schema !== "object") return;

  const record = data as Record<string, unknown>;

  // This node IS a user → drop the sensitive keys directly.
  if (schema.uid === USER_UID) {
    for (const field of SENSITIVE_USER_FIELDS) {
      if (field in record) delete record[field];
    }
  }

  const attributes = schema.attributes;
  if (!attributes) return;

  for (const [key, attr] of Object.entries(attributes)) {
    if (!attr || typeof attr !== "object") continue;
    const value = record[key];
    if (value === null || typeof value !== "object") continue; // unpopulated fk / scalar / null

    if (attr.type === "relation" && attr.target) {
      const target = options.getModel(attr.target);
      if (target) visit(value, target, options, seen);
    } else if (attr.type === "component" && attr.component) {
      const target = options.getModel(attr.component);
      if (target) visit(value, target, options, seen);
    } else if (attr.type === "dynamiczone") {
      visitDynamicZone(value, options, seen);
    }
    // media (and every scalar/json attribute) carries no
    // users-permissions.user data: a file's createdBy/updatedBy are
    // admin::user and are already removed by the core sanitizer that runs
    // before this transform — so we deliberately do not descend into it.
  }
}

/**
 * Dynamic-zone entries are a heterogeneous array: each item names its own
 * component via `__component`, so the target schema is resolved per item.
 */
function visitDynamicZone(value: unknown, options: StripOptions, seen: WeakSet<object>): void {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const componentUid = (item as Record<string, unknown>).__component;
    if (typeof componentUid !== "string") continue;
    const target = options.getModel(componentUid);
    if (target) visit(item, target, options, seen);
  }
}
