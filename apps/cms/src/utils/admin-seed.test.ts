/**
 * FX13 admin seed: placeholders and policy-failing passwords never create a
 * super admin; a valid pair goes through admin::user.createFirstAdmin, and
 * an existing admin means no create call at all. With an admin in place a
 * refused env only warns, and a template-domain admin is flagged (FX13
 * review). Stub admin service only.
 */
import { describe, expect, it } from "vitest";

import {
  adminPasswordProblems,
  evaluateAdminSeed,
  seedAdminUser,
  TEMPLATE_ADMIN_WHERE,
  type AdminSeedInput,
  type AdminSeedStrapi,
} from "./admin-seed";

const VALID = {
  STRAPI_ADMIN_EMAIL: "Ops@Intranet.Acme.io",
  STRAPI_ADMIN_PASSWORD: "Str0ngPassw0rd",
};

const TEMPLATE = {
  STRAPI_ADMIN_EMAIL: "admin@example.com",
  STRAPI_ADMIN_PASSWORD: "change-me-please",
};

function stubStrapi(
  opts: {
    hasAdmin?: boolean;
    /** Result of the template-domain lookup (exists called with a where). */
    templateAdmin?: boolean | Error;
    createFails?: boolean;
    service?: unknown;
  } = {},
) {
  const created: AdminSeedInput[] = [];
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const existsWheres: (Record<string, unknown> | undefined)[] = [];
  const adminUserService = {
    exists: async (where?: Record<string, unknown>) => {
      existsWheres.push(where);
      if (where === undefined) return opts.hasAdmin ?? false;
      if (opts.templateAdmin instanceof Error) throw opts.templateAdmin;
      return opts.templateAdmin ?? false;
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
    log: {
      info: (m) => infos.push(m),
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
    },
  };
  return {
    strapi,
    created,
    infos,
    warns,
    errors,
    existsWheres,
  };
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

  it("rejects a placeholder on an empty admin table with an error log and no create", async () => {
    const s = stubStrapi();
    await seedAdminUser(s.strapi, TEMPLATE);
    expect(s.created).toEqual([]);
    expect(s.existsWheres).toEqual([undefined]);
    expect(s.warns).toEqual([]);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain("admin seed refused");
    expect(s.errors[0]).toContain("No admin was created");
    expect(s.errors[0]).not.toContain("change-me-please");
  });

  it("only warns (remove the values) about a refused env once an admin exists", async () => {
    const s = stubStrapi({ hasAdmin: true });
    await seedAdminUser(s.strapi, TEMPLATE);
    expect(s.created).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(s.warns).toHaveLength(1);
    expect(s.warns[0]).toContain("an admin already exists");
    expect(s.warns[0]).toContain("Remove STRAPI_ADMIN_EMAIL/STRAPI_ADMIN_PASSWORD");
    expect(s.warns[0]).not.toContain("No admin was created");
    expect(s.warns[0]).not.toContain("change-me-please");
  });

  it("does not call createFirstAdmin when an admin already exists", async () => {
    const s = stubStrapi({ hasAdmin: true });
    await seedAdminUser(s.strapi, VALID);
    expect(s.existsWheres).toEqual([undefined, TEMPLATE_ADMIN_WHERE]);
    expect(s.created).toEqual([]);
    expect(s.warns).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("flags an existing template-domain admin on every boot, configured or not", async () => {
    for (const env of [{}, VALID, TEMPLATE]) {
      const s = stubStrapi({ hasAdmin: true, templateAdmin: true });
      await seedAdminUser(s.strapi, env);
      expect(s.created).toEqual([]);
      expect(s.errors).toHaveLength(1);
      expect(s.errors[0]).toContain("most likely seeded from the old env template");
    }
  });

  it("looks for the template admin case-insensitively on every reserved domain", () => {
    expect(TEMPLATE_ADMIN_WHERE).toEqual({
      $or: [
        { email: { $endsWithi: "@example.com" } },
        { email: { $endsWithi: "@example.org" } },
        { email: { $endsWithi: "@example.net" } },
      ],
    });
  });

  it("never fails the boot when the template-admin lookup throws", async () => {
    const s = stubStrapi({ hasAdmin: true, templateAdmin: new Error("db down") });
    await expect(seedAdminUser(s.strapi, {})).resolves.toBeUndefined();
    expect(s.errors).toEqual([]);
    expect(s.warns).toEqual(["[bootstrap] template-admin check failed: db down"]);
  });

  it("does nothing beyond the existence check when unconfigured", async () => {
    const s = stubStrapi();
    await seedAdminUser(s.strapi, {});
    expect(s.existsWheres).toEqual([undefined]);
    expect(s.created).toEqual([]);
    expect(s.infos).toEqual([]);
    expect(s.warns).toEqual([]);
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

    const unconfigured = stubStrapi({ service: { create: async () => ({}) } });
    await seedAdminUser(unconfigured.strapi, {});
    expect(unconfigured.errors).toEqual([]);
  });
});
