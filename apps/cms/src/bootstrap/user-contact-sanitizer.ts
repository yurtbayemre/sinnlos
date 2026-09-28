import {
  shouldSanitizeForRole,
  stripSensitiveUserFields,
  type ModelSchema,
} from "../utils/sanitize-user-contact";

/** The slice of the Strapi instance registerUserContactSanitizer touches. */
export interface UserContactSanitizerHost {
  getModel(uid: string): ModelSchema | undefined;
  requestContext: { get(): unknown };
  sanitizers: {
    get(path: string): unknown[];
    set(path: string, value: unknown[]): unknown;
  };
}

interface RequestState {
  state?: { user?: { role?: { type?: unknown } | null } | null } | null;
}

/** The caller's users-permissions role type from a request context, if any. */
function roleTypeOf(ctx: unknown): string | undefined {
  const type = (ctx as RequestState).state?.user?.role?.type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Register a role-aware `content-api.output` sanitizer that removes employee
 * contact fields (email/phone/hireDate/officeLocation/microsoftOid) from
 * every response served to a non-privileged caller — the directory itself
 * (/api/users*, /api/users/me) AND every populated user relation in any
 * content type (announcement/wiki author, document.uploadedBy,
 * event.organizer, notification.actor, comment/reaction author, manager,
 * directReports, team.members, …). Issue #10 / P1.2.
 *
 * WHY output-side and role-aware instead of revoking guest's `user.find` or
 * marking the fields schema-`private`: see the OPEN ISSUE note on the guest
 * matrix in bootstrap/permission-matrix.ts and
 * `utils/sanitize-user-contact.ts`. Revoking `user.find` 400s every guest
 * read that populates/filters a user relation; `private` would hide the
 * fields from the member+ directory and /people too.
 *
 * WHY `set`-append and NOT `strapi.sanitizers.add(...)`: the sanitizers
 * registry's `add(path, fn)` reads the target list with a FRESH `[]` default
 * when the path is uninitialized and pushes onto that throwaway array — it
 * does not persist (verified against @strapi/core 5.49 and 5.55.1
 * registries/sanitizers.js; `content-api.output` is never pre-`set`). A plain
 * `.add` here would be a silent no-op. We read the current list (default [])
 * and `set` it back with our factory appended, which also initializes the
 * path so any later `.add` behaves.
 *
 * The factory is appended as the LAST output transform, so it runs AFTER
 * validateQuery/sanitizeQuery (never triggers throwRestrictedRelations) and
 * AFTER the core sanitizers (private/restricted-relation removal). It reads
 * the caller's role from the request AsyncLocalStorage — the same source the
 * controllers use for their `role.type` checks. No request context
 * (lifecycles, seed, cron, internal document-service reads) ⇒ never strip, so
 * internal callers keep email/phone/hireDate.
 */
export function registerUserContactSanitizer(strapi: UserContactSanitizerHost): void {
  const factory = (schema: ModelSchema) => (data: unknown) => {
    const ctx = strapi.requestContext.get();
    // No HTTP request in scope → internal call; leave the data untouched.
    if (!ctx) return data;
    if (!shouldSanitizeForRole(roleTypeOf(ctx))) return data;
    return stripSensitiveUserFields(data, schema, {
      getModel: (uid: string) => strapi.getModel(uid),
    });
  };

  const current = strapi.sanitizers.get("content-api.output");
  strapi.sanitizers.set("content-api.output", [...current, factory]);
}
