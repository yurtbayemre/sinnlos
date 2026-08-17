import { describe, expect, it } from "vitest";
import { registerUserContactSanitizer } from "./index";
import { SENSITIVE_USER_FIELDS, USER_UID, type ModelSchema } from "./utils/sanitize-user-contact";

/**
 * Wiring test for the issue #10 output sanitizer (F6).
 *
 * The pure removal/gate logic is pinned in sanitize-user-contact.test.ts. This
 * file pins the REGISTRATION SEMANTICS instead — the part that actually hangs
 * the factory onto Strapi's `content-api.output` sanitizer list — because that
 * is where a silent regression hides:
 *
 *   `strapi.sanitizers.add("content-api.output", fn)` LOOKS correct but is a
 *   no-op against @strapi/core 5.49 (registries/sanitizers.js): `add` reads the
 *   target list with a FRESH `[]` default for an uninitialized path and pushes
 *   onto that throwaway array, so nothing persists. `content-api.output` is
 *   never pre-`set`, so `.add` would leave the sanitizer UNREGISTERED and every
 *   guest would keep reading staff contact data — with no error anywhere.
 *
 * `makeSanitizers()` reproduces exactly that registry contract, and the first
 * test proves the reproduction is faithful (the trap fires). The second test
 * then runs the REAL `registerUserContactSanitizer` against it and asserts the
 * factory actually lands (length 1) — which only holds for the get()+set()
 * append the implementation uses, and fails the moment someone "simplifies" it
 * back to `.add`.
 */

/** Minimal stand-in for @strapi/core's sanitizers registry (5.49 contract). */
function makeSanitizers() {
  const store = new Map<string, unknown[]>();
  // An uninitialized path yields a FRESH [] that is NOT persisted.
  const get = (path: string): unknown[] => (store.has(path) ? store.get(path)! : []);
  const set = (path: string, value: unknown[]): void => {
    store.set(path, value);
  };
  // Faithful 5.49 no-op: read the list via get(), push onto it. For an
  // uninitialized path get() returned a throwaway [], so nothing persists.
  const add = (path: string, fn: unknown): void => {
    get(path).push(fn);
  };
  return { store, get, set, add };
}

const userModel: ModelSchema = {
  uid: USER_UID,
  attributes: {
    email: { type: "email" },
    phone: { type: "string" },
    hireDate: { type: "date" },
    officeLocation: { type: "string" },
    microsoftOid: { type: "string" },
    displayName: { type: "string" },
  },
};

/** A directory user as it reaches the output transform. */
const fullUser = () => ({
  id: 7,
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+49 30 111",
  hireDate: "2020-01-01",
  officeLocation: "Berlin HQ",
  microsoftOid: "oid-ada-123",
});

describe("content-api.output sanitizer registration (issue #10 / F6)", () => {
  it("models the 5.49 registry contract: `.add` on an uninitialized path is a silent no-op", () => {
    const s = makeSanitizers();
    s.add("content-api.output", () => {});
    // The trap: the push landed on a throwaway array, so the path is still
    // empty/uninitialized. This is exactly why the implementation must NOT
    // use `.add`.
    expect(s.get("content-api.output")).toHaveLength(0);
    expect(s.store.has("content-api.output")).toBe(false);
  });

  it("registerUserContactSanitizer appends its factory so it actually persists", () => {
    const s = makeSanitizers();
    const strapi = {
      sanitizers: s,
      requestContext: { get: () => undefined },
      getModel: () => undefined,
    };

    registerUserContactSanitizer(strapi);

    // Would be 0 if the implementation regressed to `strapi.sanitizers.add(...)`.
    expect(s.get("content-api.output")).toHaveLength(1);
    expect(s.store.get("content-api.output")).toHaveLength(1);
  });

  it("the registered factory strips for guest, keeps for member, and no-ops without a request", () => {
    const holder: { ctx: unknown } = { ctx: undefined };
    const strapi = {
      sanitizers: makeSanitizers(),
      requestContext: { get: () => holder.ctx },
      getModel: (uid: string) => (uid === USER_UID ? userModel : undefined),
    };
    registerUserContactSanitizer(strapi);

    const registered = strapi.sanitizers.get("content-api.output") as Array<
      (schema: unknown) => (data: unknown) => unknown
    >;
    expect(registered).toHaveLength(1);
    // The factory is schema-bound, then applied to the response entity.
    const sanitize = registered[0](userModel) as (data: unknown) => Record<string, unknown>;

    // guest → every sensitive field removed, identity kept.
    holder.ctx = { state: { user: { role: { type: "guest" } } } };
    const asGuest = sanitize(fullUser());
    for (const field of SENSITIVE_USER_FIELDS) expect(asGuest).not.toHaveProperty(field);
    expect(asGuest.displayName).toBe("Ada Lovelace");

    // member (privileged) → fields kept.
    holder.ctx = { state: { user: { role: { type: "member" } } } };
    const asMember = sanitize(fullUser());
    expect(asMember.email).toBe("ada@example.com");
    expect(asMember.hireDate).toBe("2020-01-01");

    // No request in scope (lifecycle / cron / seed) → internal call, kept.
    holder.ctx = undefined;
    const internal = sanitize(fullUser());
    expect(internal.email).toBe("ada@example.com");
  });
});
