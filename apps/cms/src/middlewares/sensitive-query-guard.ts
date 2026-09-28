/**
 * Query-side half of the contact-field protection (roadmap FX22, issue #10
 * follow-up).
 *
 * The output sanitizer (utils/sanitize-user-contact.ts, registered in
 * src/index.ts) removes email/phone/hireDate/officeLocation/microsoftOid from
 * every response to a non-staff caller. It never looks at the QUERY, so a
 * caller that may not read those fields could still use them to select or
 * order rows: `/api/users?filters[email][$startsWith]=a`, `sort=hireDate:asc`,
 * `/api/users/count?filters[phone][$contains]=…`, the same through any user
 * relation (`/api/announcements?filters[author][email][$eq]=…`,
 * `populate[author][filters][email][$eq]=…`) and the full-text `_q` on
 * /api/users, which searches every string column of the user table. The
 * answer then depends on the hidden value, one probe at a time.
 *
 * Rule: for a caller whose role `shouldSanitizeForRole` sanitizes (guest,
 * the `authenticated` fallback, public, unknown role, no request context),
 * a query key that resolves to a SENSITIVE_USER_FIELDS attribute of the user
 * model is refused with the core's own `Invalid key` ValidationError (400):
 *   - `filters`, at any depth: `$and`/`$or`/`$not`, through relations and
 *     components, from any root content type (so /api/users* and every user
 *     relation of a content route);
 *   - `sort`, in every form the core accepts (string, comma list, arrays,
 *     objects, dotted relation paths);
 *   - `filters` and `sort` nested in `populate`, at any populate depth;
 *   - `_q` when the root model is the user model.
 * Rejecting instead of stripping keeps the answer a function of the query
 * shape alone (the same choice as the FX05 relation guard). `fields` and
 * `populate` themselves stay allowed: they only shape the output, which the
 * sanitizer cleans. Staff roles (PRIVILEGED_ROLE_TYPES) keep every filter
 * and sort they had; the admin panel does not use the content API and is
 * unaffected. `blocked`, `provider` and `confirmed` stay filterable (the web
 * filters users by `blocked`).
 *
 * WHERE it hooks in, and why that is a global middleware: config/
 * middlewares.ts runs every global middleware BEFORE routing and before the
 * route's `authenticate` step (@strapi/core services/server/compose-endpoint
 * composes authenticate inside each route handler), so a per-request
 * middleware cannot know the caller's role, nor the route's content type.
 * Every content-API controller (core-api, users-permissions user, upload)
 * does know both: it calls `strapi.contentAPI.validate.query(ctx.query,
 * <its content type>, { auth })` before it queries, resolving the function
 * at call time. The factory below therefore wraps that function once, when
 * Strapi instantiates the global middlewares at boot (before any route is
 * registered), and returns a pass-through for the request chain. The
 * wrapper runs the core validation first (a malformed query keeps its own
 * 400) and then this walk, with the role read from the request context, the
 * same source as the output sanitizer. src/index.ts wraps
 * `contentAPI.sanitize.query` for FX05; this guard leaves it alone.
 * sensitive-query-guard.test.ts pins the Strapi behaviour this relies on.
 *
 * Fails loudly: if a Strapi upgrade moves `contentAPI.validate.query`, boot
 * throws instead of silently reopening the probe.
 *
 * Every refusal is logged at warn level (`[sensitive-query-guard] 400 …`,
 * method, path, model, role; no values), so a web query that trips the
 * guard shows up in the cms log.
 */
import { errors, traverse, validate } from "@strapi/utils";
import {
  SENSITIVE_USER_FIELDS,
  USER_UID,
  shouldSanitizeForRole,
} from "../utils/sanitize-user-contact";

/** The core's content-API query validator (`strapi.contentAPI.validate.query`). */
export type ValidateQuery = ReturnType<typeof validate.createAPIValidators>["query"];

/** A Strapi model as the core validators and traversals take it. */
export type CoreModel = Parameters<ValidateQuery>[1];

type Visitor = Parameters<typeof traverse.traverseQueryFilters>[0];
type Traversal = (
  visitor: Visitor,
  options: Parameters<typeof traverse.traverseQueryFilters>[1],
  data: unknown,
) => Promise<unknown>;

const traverseFilters: Traversal = traverse.traverseQueryFilters;
const traverseSort: Traversal = traverse.traverseQuerySort;
const traversePopulate: Traversal = traverse.traverseQueryPopulate;

const SENSITIVE: ReadonlySet<string> = new Set(SENSITIVE_USER_FIELDS);

type QueryParam = "filters" | "sort" | "populate" | "_q";

interface GuardRequestContext {
  method?: string;
  path?: string;
  state?: { user?: { role?: { type?: string | null } | null } | null };
}

/** The slice of the Strapi instance the guard touches. */
export interface SensitiveQueryGuardHost {
  contentAPI?: { validate?: { query?: ValidateQuery } };
  requestContext: { get(): GuardRequestContext | undefined };
  getModel(uid: string): CoreModel | undefined;
  log: { warn(message: string): void };
}

/** Marks a wrapped validator, so a second registration does not stack. */
const GUARDED = Symbol.for("sinnlos.sensitive-query-guard");

function invalidKey(key: string, path: string | null, param: QueryParam): never {
  const where = path && path !== key ? `${key} at ${path}` : key;
  throw new errors.ValidationError(`Invalid key ${where}`, {
    key,
    path,
    source: "query",
    param,
  });
}

/** A visitor that refuses a sensitive attribute of a user node. */
const refuseSensitiveKey =
  (param: QueryParam): Visitor =>
  ({ key, attribute, schema, path }) => {
    if (attribute && schema?.uid === USER_UID && SENSITIVE.has(key)) {
      invalidKey(key, path.attribute, param);
    }
  };

/**
 * Throws `Invalid key <field>` (ValidationError, 400) when `query` filters,
 * sorts or full-text searches on a sensitive user field anywhere under
 * `schema`; resolves otherwise. Pure over the schema: no role check here.
 */
export async function assertNoSensitiveUserKeys(
  query: Record<string, unknown>,
  schema: CoreModel,
  getModel: (uid: string) => CoreModel | undefined,
): Promise<void> {
  // The traversals type getModel as total; an unknown uid yields undefined,
  // which they treat as "no attributes" (nothing below it is a user field).
  const resolve = getModel as (uid: string) => CoreModel;

  if (schema.uid === USER_UID && query._q !== undefined) invalidKey("_q", null, "_q");

  if (query.filters !== undefined) {
    await traverseFilters(
      refuseSensitiveKey("filters"),
      { schema, getModel: resolve },
      query.filters,
    );
  }
  if (query.sort !== undefined) {
    await traverseSort(refuseSensitiveKey("sort"), { schema, getModel: resolve }, query.sort);
  }
  if (query.populate !== undefined) {
    // traverseQueryPopulate hands the `filters`/`sort` keywords of a
    // populate fragment to the visitor without descending into them (its
    // own ignore rule); the visitor walks them against the fragment's model.
    // A key is a keyword, not an attribute, when it is no attribute or sits
    // right under a populated attribute (the core validator's rule).
    const populateVisitor: Visitor = async ({
      key,
      value,
      attribute,
      parent,
      schema: node,
      path,
    }) => {
      if (attribute && !parent?.attribute) return;
      const options = { schema: node, getModel: resolve, path };
      if (key === "filters") await traverseFilters(refuseSensitiveKey("populate"), options, value);
      if (key === "sort") await traverseSort(refuseSensitiveKey("populate"), options, value);
    };
    await traversePopulate(populateVisitor, { schema, getModel: resolve }, query.populate);
  }
}

/**
 * Wrap `strapi.contentAPI.validate.query` with the guard. Idempotent; throws
 * when the validator is missing (fail closed at boot).
 */
export function registerSensitiveQueryGuard(strapi: SensitiveQueryGuardHost): void {
  const validator = strapi.contentAPI?.validate;
  const original = validator?.query;
  if (!validator || typeof original !== "function") {
    throw new Error(
      "[sensitive-query-guard] strapi.contentAPI.validate.query not found — refusing to boot without the FX22 guard",
    );
  }
  if (GUARDED in original) return;

  const guarded: ValidateQuery = async (query, schema, options) => {
    const result = await original.call(validator, query, schema, options);
    const ctx = strapi.requestContext.get();
    const role = ctx?.state?.user?.role?.type;
    if (!shouldSanitizeForRole(role)) return result;
    try {
      await assertNoSensitiveUserKeys(query, schema, (uid) => strapi.getModel(uid));
    } catch (error) {
      if (error instanceof errors.ValidationError) {
        strapi.log.warn(
          `[sensitive-query-guard] 400 ${error.message} on ${ctx?.method ?? "?"} ${ctx?.path ?? "?"} (${schema.uid}, role ${role ?? "none"})`,
        );
      }
      throw error;
    }
    return result;
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  validator.query = guarded;
}

/**
 * `global::sensitive-query-guard` (config/middlewares.ts). Strapi calls this
 * factory once while it instantiates the global middlewares at boot; it
 * installs the guard and hands the request chain a pass-through.
 */
export default (_config: unknown, { strapi }: { strapi: SensitiveQueryGuardHost }) => {
  registerSensitiveQueryGuard(strapi);
  return (_ctx: unknown, next: () => Promise<unknown>) => next();
};
