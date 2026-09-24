/**
 * Seed a first Strapi super admin from environment variables when the
 * admin_users table is empty (roadmap FX13). This lets a fresh clone boot
 * straight into a usable admin panel without the interactive registration
 * form.
 *
 * Env vars:
 *   STRAPI_ADMIN_EMAIL     — login email for the Super Admin
 *   STRAPI_ADMIN_PASSWORD  — plaintext password, hashed by Strapi on insert
 *   STRAPI_ADMIN_FIRSTNAME — optional, defaults to "Admin"
 *   STRAPI_ADMIN_LASTNAME  — optional, defaults to "User"
 * Email and password go together; both empty = classic interactive flow.
 *
 * Safety (FX13):
 *   - The templates used to ship a working credential (admin@example.com /
 *     change-me-please) and the seed called `admin::user.create`, which
 *     hashes but never validates — a publicly known super-admin login on the
 *     publicly routed /admin. Known placeholders and passwords failing the
 *     Strapi admin policy (@strapi/admin 5.49 common-validators.js: 8+ chars,
 *     at most 72 bytes, lower, upper, digit) are now REFUSED with an error log;
 *     the admin is then never created.
 *   - Creation goes through `admin::user.createFirstAdmin`, which locks the
 *     super-admin role row and re-checks "no admin yet" inside one
 *     transaction (no check-then-create race across processes).
 *   - Runs ONLY while no admin exists. Rotating the env password later does
 *     NOT overwrite the existing admin — that happens in the admin panel.
 *
 * Strapi Community Edition has no admin-panel SSO, so this is the
 * friction-free alternative to the registration form after wiping the DB.
 */
import { isPlaceholderSecret } from "./env-guard";

/** Documentation-reserved domains (RFC 2606) — a copied template, not a person. */
const PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "example.org", "example.net"];

export interface AdminSeedInput {
  email: string;
  password: string;
  firstname: string;
  lastname: string;
}

export type AdminSeedDecision =
  | { kind: "skip" }
  | { kind: "refuse"; reasons: string[] }
  | { kind: "create"; admin: AdminSeedInput };

/** Mirror of the Strapi admin password policy; returns the failed rules. */
export function adminPasswordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push("at least 8 characters");
  if (new TextEncoder().encode(password).length > 72) problems.push("at most 72 bytes");
  if (!/[a-z]/.test(password)) problems.push("a lowercase letter");
  if (!/[A-Z]/.test(password)) problems.push("an uppercase letter");
  if (!/\d/.test(password)) problems.push("a digit");
  return problems;
}

/** Decide what the seed does for this env. Pure; never echoes the password. */
export function evaluateAdminSeed(env: Record<string, string | undefined>): AdminSeedDecision {
  const email = (env.STRAPI_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = env.STRAPI_ADMIN_PASSWORD ?? "";
  if (!email && !password) return { kind: "skip" };

  const reasons: string[] = [];
  if (!email || !password) {
    reasons.push("STRAPI_ADMIN_EMAIL and STRAPI_ADMIN_PASSWORD must be set together");
  }
  if (email) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reasons.push("STRAPI_ADMIN_EMAIL is not a valid e-mail address");
    } else if (PLACEHOLDER_EMAIL_DOMAINS.includes(domain) || isPlaceholderSecret(email)) {
      reasons.push("STRAPI_ADMIN_EMAIL is a template placeholder");
    }
  }
  if (password) {
    if (isPlaceholderSecret(password)) {
      reasons.push("STRAPI_ADMIN_PASSWORD is a template placeholder");
    }
    const problems = adminPasswordProblems(password);
    if (problems.length > 0) {
      reasons.push(`STRAPI_ADMIN_PASSWORD fails the admin policy (needs ${problems.join(", ")})`);
    }
  }
  if (reasons.length > 0) return { kind: "refuse", reasons };

  return {
    kind: "create",
    admin: {
      email,
      password,
      firstname: (env.STRAPI_ADMIN_FIRSTNAME ?? "").trim() || "Admin",
      lastname: (env.STRAPI_ADMIN_LASTNAME ?? "").trim() || "User",
    },
  };
}

/** The slice of the Strapi instance the seed uses. */
export interface AdminSeedStrapi {
  service(uid: string): unknown;
  log: {
    info(message: string): void;
    error(message: string): void;
  };
}

interface AdminUserService {
  exists(): Promise<boolean>;
  createFirstAdmin(attributes: AdminSeedInput): Promise<unknown>;
}

function isAdminUserService(value: unknown): value is AdminUserService {
  const service = value as Partial<AdminUserService> | null | undefined;
  return typeof service?.exists === "function" && typeof service?.createFirstAdmin === "function";
}

export async function seedAdminUser(
  strapi: AdminSeedStrapi,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const decision = evaluateAdminSeed(env);
  if (decision.kind === "skip") return;
  if (decision.kind === "refuse") {
    strapi.log.error(
      `[bootstrap] admin seed refused: ${decision.reasons.join("; ")}. ` +
        "No admin was created — set real STRAPI_ADMIN_* values or register the first admin at /admin.",
    );
    return;
  }

  const users = strapi.service("admin::user");
  if (!isAdminUserService(users)) {
    strapi.log.error(
      "[bootstrap] admin seed skipped: admin::user.createFirstAdmin is not available in this Strapi version",
    );
    return;
  }
  if (await users.exists()) return;

  try {
    await users.createFirstAdmin(decision.admin);
    strapi.log.info(`[bootstrap] created initial Super Admin ${decision.admin.email}`);
  } catch (err) {
    strapi.log.error(`[bootstrap] failed to create initial admin user: ${(err as Error).message}`);
  }
}
