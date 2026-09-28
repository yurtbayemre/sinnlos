import { describe, expect, it } from "vitest";
import { PROFILE_TEXT_MAX } from "../api/profile/controllers/profile";
import { matchWhere } from "../test/strapi-stub.test.helper";
import type { GraphMe } from "./graph";
import {
  ENTRA_MANAGED_PROFILE_FIELDS,
  USER_TEXT_MAX,
  buildProfileUpdate,
  capUserText,
  decideEmailSync,
  decideManagerSync,
  departmentName,
  isEntraBound,
  managerBackfillWhere,
  newIdentityEmail,
  pickDepartment,
  syncedEmail,
} from "./profile";

/**
 * D-ENTRA-01 spec J: the Entra-owned profile. The department lookup itself
 * ($eqi on published names) and the writes run against a real database in
 * integration/provision.integration.test.ts.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const OID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const MANAGER = "5a5a5a5a-6b6b-4c7c-8d8d-9e9e9e9e9e9e";

const me = (overrides: Partial<GraphMe> = {}): GraphMe => ({
  id: OID,
  displayName: "Ada Lovelace",
  mail: "Ada@Example.test",
  userPrincipalName: "ada.upn@example.test",
  jobTitle: "Engineer",
  department: "IT Engineering",
  officeLocation: "Room 1",
  businessPhones: ["+49 30 1234", "+49 30 5678"],
  userType: "Member",
  ...overrides,
});

describe("buildProfileUpdate", () => {
  it("mirrors Graph's scalars, phone from businessPhones[0]", () => {
    expect(buildProfileUpdate(me())).toEqual({
      displayName: "Ada Lovelace",
      jobTitle: "Engineer",
      officeLocation: "Room 1",
      phone: "+49 30 1234",
    });
  });

  it("clears jobTitle, officeLocation and phone when Graph has none", () => {
    expect(
      buildProfileUpdate(me({ jobTitle: null, officeLocation: "  ", businessPhones: [] })),
    ).toEqual({ displayName: "Ada Lovelace", jobTitle: null, officeLocation: null, phone: null });
  });

  it("cuts every text to 255 code points: Entra allows a 256-character displayName, varchar(255) does not", () => {
    // The same limit as PUT /api/me: both write the same varchar(255) columns.
    expect(USER_TEXT_MAX).toBe(255);
    expect(USER_TEXT_MAX).toBe(PROFILE_TEXT_MAX);
    const update = buildProfileUpdate(
      me({
        displayName: "N".repeat(256),
        jobTitle: ` ${"J".repeat(300)} `,
        officeLocation: "\u{1F3E2}".repeat(256),
        businessPhones: ["1".repeat(256)],
      }),
    );
    expect(update).toEqual({
      displayName: "N".repeat(255),
      jobTitle: "J".repeat(255),
      // Code points, as Postgres counts them: 255 emoji, 510 UTF-16 units.
      officeLocation: "\u{1F3E2}".repeat(255),
      phone: "1".repeat(255),
    });
    // Exactly 255 stays; a cut that ends in a space drops it.
    expect(buildProfileUpdate(me({ displayName: "N".repeat(255) })).displayName).toBe(
      "N".repeat(255),
    );
    expect(capUserText(`${"a".repeat(254)} b`)).toBe("a".repeat(254));
    expect(capUserText("short")).toBe("short");
  });

  it("never clears the display name with an empty value", () => {
    for (const displayName of [null, "", "   "]) {
      expect(buildProfileUpdate(me({ displayName }))).not.toHaveProperty("displayName");
    }
  });

  it("locks exactly the four scalar fields", () => {
    expect([...ENTRA_MANAGED_PROFILE_FIELDS].sort()).toEqual(
      ["displayName", "jobTitle", "officeLocation", "phone"].sort(),
    );
  });
});

describe("e-mail", () => {
  it("syncs only rows the exchange created (provider microsoft)", () => {
    expect(syncedEmail(me(), "microsoft")).toBe("ada@example.test");
    expect(syncedEmail(me({ mail: null }), "microsoft")).toBe("ada.upn@example.test");
    expect(syncedEmail(me({ mail: null, userPrincipalName: null }), "microsoft")).toBeNull();
    for (const provider of ["local", null, undefined, "Microsoft"]) {
      expect(syncedEmail(me(), provider)).toBeNull();
    }
  });

  it("keeps the old value on a conflict, and writes nothing unchanged", () => {
    expect(decideEmailSync("new@example.test", "old@example.test", false)).toEqual({
      kind: "set",
      email: "new@example.test",
    });
    expect(decideEmailSync("new@example.test", "old@example.test", true)).toEqual({
      kind: "keep",
      reason: "conflict",
    });
    expect(decideEmailSync("ada@example.test", "Ada@Example.test", true)).toEqual({
      kind: "keep",
      reason: "unchanged",
    });
    expect(decideEmailSync(null, "old@example.test", false)).toEqual({
      kind: "keep",
      reason: "not-synced",
    });
  });

  it("derives a new identity's address from mail, then the claims, then the UPN", () => {
    const claims = { email: "Claim@Example.test", preferredUsername: "pref@example.test" };
    expect(newIdentityEmail(me(), claims)).toBe("ada@example.test");
    expect(newIdentityEmail(me({ mail: null }), claims)).toBe("claim@example.test");
    expect(newIdentityEmail(me({ mail: null }), { ...claims, email: null })).toBe(
      "ada.upn@example.test",
    );
    expect(newIdentityEmail(null, { ...claims, email: null })).toBe("pref@example.test");
    expect(newIdentityEmail(null, { email: null, preferredUsername: null })).toBeNull();
  });
});

describe("department", () => {
  it("clears on an empty value", () => {
    expect(departmentName(me({ department: null }))).toBeNull();
    expect(departmentName(me({ department: "   " }))).toBeNull();
    expect(pickDepartment(null, [{ documentId: "d1" }])).toEqual({
      kind: "clear",
      reason: "empty",
    });
    expect(departmentName(me({ department: "  IT Engineering " }))).toBe("IT Engineering");
  });

  it("links exactly one match, clears on none or several", () => {
    expect(pickDepartment("IT", [{ documentId: "d1" }])).toEqual({ kind: "set", documentId: "d1" });
    // The same document twice (twin rows) is one match.
    expect(pickDepartment("IT", [{ documentId: "d1" }, { documentId: "d1" }])).toEqual({
      kind: "set",
      documentId: "d1",
    });
    expect(pickDepartment("IT", [])).toEqual({ kind: "clear", reason: "no-match" });
    expect(pickDepartment("IT", [{ documentId: "d1" }, { documentId: "d2" }])).toEqual({
      kind: "clear",
      reason: "ambiguous",
    });
  });
});

describe("manager", () => {
  it("sets on 200, clears on 404, keeps on any failure", () => {
    expect(decideManagerSync({ ok: true, data: MANAGER })).toEqual({
      kind: "set",
      managerOid: MANAGER,
    });
    expect(decideManagerSync({ ok: true, data: null })).toEqual({ kind: "clear" });
    for (const reason of [403, 429, 500, "timeout", "network", "malformed"] as const) {
      expect(decideManagerSync({ ok: false, reason })).toEqual({ kind: "keep" });
    }
  });

  it("back-fills exactly the users of this tenant waiting for this manager", () => {
    const where = managerBackfillWhere(TENANT, MANAGER);
    const rows = [
      { id: 1, entraTenantId: TENANT, entraManagerOid: MANAGER },
      { id: 2, entraTenantId: TENANT, entraManagerOid: OID },
      { id: 3, entraTenantId: "99999999-8888-4777-8666-555555555555", entraManagerOid: MANAGER },
      { id: 4, entraTenantId: null, entraManagerOid: MANAGER },
      { id: 5, entraTenantId: TENANT, entraManagerOid: null },
    ];
    expect(
      rows
        .filter((row) => matchWhere("plugin::users-permissions.user", row, where))
        .map((r) => r.id),
    ).toEqual([1]);
  });
});

describe("isEntraBound", () => {
  it("is true only with a tenant id", () => {
    expect(isEntraBound({ entraTenantId: TENANT })).toBe(true);
    for (const row of [
      { entraTenantId: null },
      { entraTenantId: "" },
      { entraTenantId: " " },
      {},
      null,
      undefined,
    ]) {
      expect(isEntraBound(row)).toBe(false);
    }
  });
});
