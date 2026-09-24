/**
 * FX13 admin seed: placeholders and policy-failing passwords never create a
 * super admin; a valid pair goes through admin::user.createFirstAdmin, and
 * an existing admin means no create call at all. Stub admin service only.
 */
import { describe, expect, it } from "vitest";

import {
  adminPasswordProblems,
  evaluateAdminSeed,
  seedAdminUser,
  type AdminSeedInput,
  type AdminSeedStrapi,
} from "./admin-seed";

const VALID = {
  STRAPI_ADMIN_EMAIL: "Ops@Intranet.Acme.io",
  STRAPI_ADMIN_PASSWORD: "Str0ngPassw0rd",
};

function stubStrapi(opts: { hasAdmin?: boolean; createFails?: boolean; service?: unknown } = {}) {
  const created: AdminSeedInput[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  let existsCalls = 0;
  const adminUserService = {
    exists: async () => {
      existsCalls++;
      return opts.hasAdmin ?? false;
    },
    createFirstAdmin: async (attributes: AdminSeedInput) => {
      if (opts.createFails) throw new Error("You cannot register a new super admin");
      created.push(attributes);
      return { id: 1, ...attributes };
    },
  };
  const strapi: AdminSeedStrapi = {
    service: (uid) => {
      expect(uid).toBe("admin::user");
      return opts.service !== undefined ? opts.service : adminUserService;
    },
    log: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
  };
  return { strapi, created, infos, errors, existsCalls: () => existsCalls };
}

describe("adminPasswordProblems (Strapi admin policy mirror)", () => {
  it("accepts 8+ chars with lower, upper and digit", () => {
    expect(adminPasswordProblems("Abcdefg1")).toEqual([]);
  });

  it("names every failed rule", () => {
    expect(adminPasswordProblems("abc")).toEqual([
      "at least 8 characters",
      "an uppercase letter",
      "a digit",
    ]);
    expect(adminPasswordProblems("ABCDEFGH1")).toEqual(["a lowercase letter"]);
    expect(adminPasswordProblems(`Aa1${"x".repeat(70)}`)).toEqual(["at most 72 bytes"]);
  });
});

describe("evaluateAdminSeed", () => {
  it("skips silently when nothing is configured", () => {
    expect(evaluateAdminSeed({})).toEqual({ kind: "skip" });
    expect(evaluateAdminSeed({ STRAPI_ADMIN_EMAIL: "", STRAPI_ADMIN_PASSWORD: "" })).toEqual({
      kind: "skip",
    });
  });

  it("refuses the shipped template credential", () => {
    const decision = evaluateAdminSeed({
      STRAPI_ADMIN_EMAIL: "admin@example.com",
      STRAPI_ADMIN_PASSWORD: "change-me-please",
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reasons.join(" | ")).toContain("STRAPI_ADMIN_EMAIL is a template placeholder");
    expect(decision.reasons.join(" | ")).toContain(
      "STRAPI_ADMIN_PASSWORD is a template placeholder",
    );
    expect(decision.reasons.join(" | ")).toContain("fails the admin policy");
  });

  it("refuses a policy-compliant placeholder password", () => {
    const decision = evaluateAdminSeed({
      STRAPI_ADMIN_EMAIL: "ops@acme.io",
      STRAPI_ADMIN_PASSWORD: "Change-Me-2026",
    });
    expect(decision).toEqual({
      kind: "refuse",
      reasons: ["STRAPI_ADMIN_PASSWORD is a template placeholder"],
    });
  });

  it.each(["weakpass", "Short1", "alllowercase1", "NoDigitsHere"])(
    "refuses the weak password %s",
    (password) => {
      const decision = evaluateAdminSeed({
        STRAPI_ADMIN_EMAIL: "ops@acme.io",
        STRAPI_ADMIN_PASSWORD: password,
      });
      expect(decision.kind).toBe("refuse");
    },
  );

  it("refuses half a configuration and invalid / reserved e-mails", () => {
    expect(evaluateAdminSeed({ STRAPI_ADMIN_EMAIL: "ops@acme.io" }).kind).toBe("refuse");
    expect(evaluateAdminSeed({ STRAPI_ADMIN_PASSWORD: "Str0ngPassw0rd" }).kind).toBe("refuse");
    for (const email of ["not-an-email", "ops@example.org", "someone@example.net"]) {
      expect(
        evaluateAdminSeed({ STRAPI_ADMIN_EMAIL: email, STRAPI_ADMIN_PASSWORD: "Str0ngPassw0rd" })
          .kind,
      ).toBe("refuse");
    }
  });

  it("never echoes the password in the reasons", () => {
    const decision = evaluateAdminSeed({
      STRAPI_ADMIN_EMAIL: "ops@acme.io",
      STRAPI_ADMIN_PASSWORD: "secretish",
    });
    expect(JSON.stringify(decision)).not.toContain("secretish");
  });

  it("accepts a valid pair (e-mail lowercased, name defaults)", () => {
    expect(evaluateAdminSeed(VALID)).toEqual({
      kind: "create",
      admin: {
        email: "ops@intranet.acme.io",
        password: "Str0ngPassw0rd",
        firstname: "Admin",
        lastname: "User",
      },
    });
    const named = evaluateAdminSeed({
      ...VALID,
      STRAPI_ADMIN_FIRSTNAME: " Emre ",
      STRAPI_ADMIN_LASTNAME: "Y",
    });
    expect(named.kind === "create" && [named.admin.firstname, named.admin.lastname]).toEqual([
      "Emre",
      "Y",
    ]);
  });
});

describe("seedAdminUser", () => {
  it("creates the first admin via createFirstAdmin for a valid pair", async () => {
    const s = stubStrapi();
    await seedAdminUser(s.strapi, VALID);
    expect(s.created).toEqual([
      {
        email: "ops@intranet.acme.io",
        password: "Str0ngPassw0rd",
        firstname: "Admin",
        lastname: "User",
      },
    ]);
    expect(s.infos).toEqual(["[bootstrap] created initial Super Admin ops@intranet.acme.io"]);
    expect(s.errors).toEqual([]);
  });

  it("rejects a placeholder with an error log and never touches the admin service", async () => {
    const s = stubStrapi();
    await seedAdminUser(s.strapi, {
      STRAPI_ADMIN_EMAIL: "admin@example.com",
      STRAPI_ADMIN_PASSWORD: "change-me-please",
    });
    expect(s.created).toEqual([]);
    expect(s.existsCalls()).toBe(0);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("admin seed refused");
    expect(s.errors[0]).not.toContain("change-me-please");
  });

  it("does not call createFirstAdmin when an admin already exists", async () => {
    const s = stubStrapi({ hasAdmin: true });
    await seedAdminUser(s.strapi, VALID);
    expect(s.existsCalls()).toBe(1);
    expect(s.created).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("does nothing at all when unconfigured", async () => {
    const s = stubStrapi();
    await seedAdminUser(s.strapi, {});
    expect(s.existsCalls()).toBe(0);
    expect(s.created).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("logs (never throws) when createFirstAdmin loses a race", async () => {
    const s = stubStrapi({ createFails: true });
    await expect(seedAdminUser(s.strapi, VALID)).resolves.toBeUndefined();
    expect(s.errors).toEqual([
      "[bootstrap] failed to create initial admin user: You cannot register a new super admin",
    ]);
  });

  it("refuses to fall back when the first-admin path is missing", async () => {
    const s = stubStrapi({ service: { create: async () => ({}) } });
    await seedAdminUser(s.strapi, VALID);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("createFirstAdmin is not available");
  });
});
