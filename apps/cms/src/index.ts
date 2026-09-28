import { syncAdvancedSettings } from "./bootstrap/advanced-settings";
import { checkEntraConfig, reportEntraStatus, syncAuthProviders } from "./bootstrap/auth-providers";
import { ensureEntraIdentityIndex } from "./bootstrap/entra-identity-index";
import { registerRestrictedRelationGuard } from "./bootstrap/restricted-relation-guard";
import { ensureRoles, syncRolePermissions } from "./bootstrap/sync-permissions";
import { registerUserContactSanitizer } from "./bootstrap/user-contact-sanitizer";
import {
  assertTimestamptzContract,
  prepareDatetimeContract,
  registerTimestamptzGuard,
} from "./database/ensure-timestamptz";
import { reportDigestConfig } from "./digest/send-digests";
import { parseEntraConfig } from "./entra/config";
import { seedAdminUser } from "./utils/admin-seed";
import { ensureDraftTwins } from "./utils/draft-twins";
import { enforceSecretGuard } from "./utils/env-guard";
import { registerLiveEventSubscriber } from "./utils/live-events";
import { assertNoOrgDrafts } from "./utils/org-dp-guard";
import { backfillPollAudience } from "./utils/poll-audience-backfill";
import { registerPollAudienceGuard } from "./utils/poll-audience-guard";

/**
 * Strapi application lifecycle: a thin orchestrator (roadmap B01). The
 * pieces live in bootstrap/*:
 *   - roles.ts: the six intranet roles;
 *   - permission-matrix.ts: the grants per role (PERMISSION_MATRIX,
 *     CUSTOM_ACTION_GRANTS, REVOKED_PERMISSIONS) and the pure set logic;
 *   - sync-permissions.ts: the role seed and the permission sync at boot;
 *   - advanced-settings.ts: the users-permissions advanced settings;
 *   - auth-providers.ts: the Entra configuration check, the sign-in
 *     provider grants and the `[entra]` status line (D-ENTRA-01);
 *   - entra-identity-index.ts: the (tenant, object id) unique index;
 *   - user-contact-sanitizer.ts and restricted-relation-guard.ts: the two
 *     content-API hooks register() installs.
 * The ORDER of the calls below is load-bearing (see the comments), and
 * index.register.test.ts pins the register() side.
 */

// The permission constants stay importable from here (the generated
// infra/diagnostics/prod-perm-diff.sql names this file as its source).
export {
  CUSTOM_ACTION_GRANTS,
  PERMISSION_MATRIX,
  REVOKED_PERMISSIONS,
  USER_READ_ACTIONS,
  USER_UID,
} from "./bootstrap/permission-matrix";
export { ROLES, type RoleSeed } from "./bootstrap/roles";
export {
  registerRestrictedRelationGuard,
  registerUserContactSanitizer,
  syncAdvancedSettings,
  syncRolePermissions,
};
export type { RestrictedRelationGuardHost } from "./bootstrap/restricted-relation-guard";

export default {
  async register({ strapi }: { strapi: any }) {
    // Decision 05: refuse to boot while department/team hold draft rows.
    // Strapi would delete them in the beforeSync hook right after register()
    // (draftAndPublish true -> false). FIRST, so nothing in register() runs
    // on such a database; see utils/org-dp-guard.ts.
    await assertNoOrgDrafts(strapi);
    // Datetime contract (database/ensure-timestamptz.ts): log the zones,
    // verify the DB session runs in UTC, refuse a non-UTC process on a fresh
    // database, before the one-time repair or (beforeSync hook) on a boot
    // that migrates or changes the schema, and convert every naive
    // timestamp column right after schema sync (afterSync hook).
    await prepareDatetimeContract(strapi);
    registerTimestamptzGuard(strapi);
    // FX13: refuse to boot in production with template placeholder secrets
    // (change-me / toBeModified / <secret>); outside production it only warns.
    enforceSecretGuard(process.env, strapi.log);
    // D-ENTRA-01 spec A: with ENTRA_ENABLED=1 an invalid Entra configuration
    // refuses the boot, naming every bad variable; with Entra off it only
    // parses (MS_* values are ignored then). bootstrap() re-reads it.
    checkEntraConfig(strapi.log);
    registerUserContactSanitizer(strapi);
    registerRestrictedRelationGuard(strapi);
    // Decision 02, fail closed: every Document Service write of a poll sets
    // audience='departments' on each row of the poll that links a
    // department, in the write's own transaction (utils/poll-audience-guard.ts).
    // Here, before any plugin or bootstrap code writes a poll; throws when
    // strapi.documents.use is gone.
    registerPollAudienceGuard(strapi);
  },

  async bootstrap({ strapi }: { strapi: any }) {
    // Datetime contract: no start while any column is still timestamp
    // without time zone (retries what afterSync could not convert).
    await assertTimestamptzContract(strapi);

    // Live-update pings for the web SSE bus (issue #17/#27). Registered
    // before any seeding so bulk writes exercise the batching path; the
    // emitter itself no-ops unless WEB_INTERNAL_URL is set.
    registerLiveEventSubscriber(strapi);

    // Roles before the permission sync, which grants per role.
    await ensureRoles(strapi);
    await syncRolePermissions(strapi);
    await syncAdvancedSettings(strapi);
    // D-ENTRA-01 spec L, on every boot and whether Entra is on or off: the
    // (tenant, object id) unique index (a failure is logged, and fatal only
    // with Entra on), grant.email = local sign-in on, grant.microsoft off,
    // then one `[entra] disabled|enabled …` line. The public
    // forgot/reset-password revocation is part of the permission sync above.
    const entra = parseEntraConfig(process.env);
    await ensureEntraIdentityIndex(strapi, { entraEnabled: entra.enabled });
    await syncAuthProviders(strapi, entra);
    reportEntraStatus(strapi.log, entra);
    // Decision 02: give existing polls their `audience` flag ('departments'
    // when they link a department). A no-op once no row is NULL. One
    // transaction; on any error it rolls back and THROWS, so the cms does
    // not start with a restricted poll left open (fail closed, see
    // utils/poll-audience-backfill.ts). Before the draft-twin repair below,
    // so a cloned draft copies the flag.
    await backfillPollAudience(strapi);
    await seedAdminUser(strapi);
    // FX13 review: SMTP set without DIGEST_FROM / PUBLIC_WEB_URL (the owner
    // defaults are gone) → say so at boot, not only at the 07:30 run.
    reportDigestConfig(strapi.log);

    const { seedDemoData } = await import("./seed-demo");
    await seedDemoData(strapi);

    // Last: give published-only documents of draft & publish types (written
    // by the demo seed before 2026-09-26) their draft twin, so the admin
    // lists them and editing + publishing there keeps their relations. A
    // no-op once every document has one; logs "[draft-twins] created N
    // draft(s) for <uid>" per repaired type and never fails the boot (see
    // utils/draft-twins.ts).
    await ensureDraftTwins(strapi);
  },
};
