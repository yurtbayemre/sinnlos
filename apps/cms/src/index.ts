import { syncAdvancedSettings } from "./bootstrap/advanced-settings";
import {
  checkEntraConfig,
  checkOidcConfig,
  reportEntraStatus,
  reportOidcStatus,
  syncAuthProviders,
} from "./bootstrap/auth-providers";
import { ensureDocumentIndexes } from "./bootstrap/document-indexes";
import { registerDocumentMiddlewares } from "./bootstrap/document-middlewares";
import {
  ensureEmailIndex,
  ensureEntraIdentityIndex,
  ensureOidcIdentityIndex,
} from "./bootstrap/entra-identity-index";
import { removeHiddenTypeWritePermissions } from "./bootstrap/hidden-type-permissions";
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
import { parseOidcConfig } from "./oidc/config";
import { assertMfaGate, parseMfaRequiredRoles, sealService } from "./utils/mfa-core";
import { seedAdminUser } from "./utils/admin-seed";
import { backfillDepartmentAudience } from "./utils/department-audience-backfill";
import { ensureDraftTwins } from "./utils/draft-twins";
import { enforceSecretGuard } from "./utils/env-guard";
import { parseMeiliConfig, searchStatusLine } from "./search/meili-index";
import { registerLiveEventSubscriber } from "./utils/live-events";
import { registerMediaTombstoneGuard } from "./utils/media-tombstone-guard";
import { assertNoOrgDrafts } from "./utils/org-dp-guard";
import { backfillPollAudience } from "./utils/poll-audience-backfill";
import { backfillRevisions } from "./utils/revision-backfill";
import { assertNoRevisionDrafts } from "./utils/revision-dp-guard";
import { backfillTargetingFlags } from "./utils/targeting-flags-backfill";

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
 *   - document-middlewares.ts: every Document Service middleware, in its
 *     slot order (decision 06 §K);
 *   - document-indexes.ts: the revision, schedule and wiki history indexes;
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
    // Batch 16 (DA03): the same for wiki_revisions, whose draft & publish is
    // off since then. A rollback to batch 15.1 or older clones one draft
    // twin per revision; infra/migrations/wiki-revision-dp/migrate.sql
    // removes them before a roll-forward. See utils/revision-dp-guard.ts.
    await assertNoRevisionDrafts(strapi);
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
    // v0.25.0, the same for OIDC sign-in (and ENTRA_ENABLED=1 next to it is refused).
    checkOidcConfig(strapi.log);
    // v0.21: with MEILISEARCH_ENABLED=1 a missing URL or write key refuses
    // the boot (search/meili-index.ts); off, nothing is read.
    parseMeiliConfig(process.env);
    // v0.27: an unknown role in MFA_REQUIRED_ROLES refuses the boot, and so
    // does any users-permissions JWT mode but legacy-support (refresh mode
    // would bypass the token version and the second-factor claims).
    parseMfaRequiredRoles(process.env.MFA_REQUIRED_ROLES);
    const jwtMode =
      strapi.config?.get?.("plugin::users-permissions.jwtManagement", "legacy-support") ??
      "legacy-support";
    if (jwtMode !== "legacy-support") {
      throw new Error(
        `[auth] users-permissions jwtManagement=${String(jwtMode)} is not supported: only legacy-support keeps the token version and the second factor (v0.27)`,
      );
    }
    registerUserContactSanitizer(strapi);
    registerRestrictedRelationGuard(strapi);
    // Every Document Service middleware, in its slot order
    // (bootstrap/document-middlewares.ts, decision 06 §K), among them:
    //  - decision 02, fail closed: every write of a poll sets
    //    audience='departments' on each row that links a department, in the
    //    write's own transaction (utils/poll-audience-guard.ts);
    //  - FX29 residual, the same for documents and quick links (batch 12
    //    review B12-01, utils/department-audience-guard.ts), so a department
    //    delete cannot open them, not even through a publish or an admin
    //    form that copied the row before the delete;
    //  - FX40: a password the admin panel (or any Document Service update)
    //    sets raises the user's token version in the write's own
    //    transaction, and no write may carry tokenVersion itself
    //    (extensions/users-permissions/strapi-server.ts createUserWriteGuard).
    // Here, before any plugin or bootstrap code writes a row; throws when
    // strapi.documents.use is gone.
    registerDocumentMiddlewares(strapi);
  },

  async bootstrap({ strapi }: { strapi: any }) {
    // Datetime contract: no start while any column is still timestamp
    // without time zone (retries what afterSync could not convert).
    await assertTimestamptzContract(strapi);
    // Decision 06 §G, §D: the unique index the document lock's
    // `insert … on conflict` needs, and the scheduler's partial indexes.
    // Before any Document Service write of this boot (seed, backfills,
    // draft twins); throws, so the cms does not start without them.
    await ensureDocumentIndexes(strapi);

    // Live-update pings for the web SSE bus (issue #17/#27). Registered
    // before any seeding so bulk writes exercise the batching path; the
    // emitter itself no-ops unless WEB_INTERNAL_URL is set.
    registerLiveEventSubscriber(strapi);
    // Every media field without its own claim refuses a tombstoned file.
    registerMediaTombstoneGuard(strapi);

    // Roles before the permission sync, which grants per role.
    await ensureRoles(strapi);
    await syncRolePermissions(strapi);
    // Batch 15.1: no admin role keeps Content Manager writes on a type the
    // panel hides (wiki revisions); Strapi's own cleanup can skip rows.
    // Throws when the admin permission service is gone.
    await removeHiddenTypeWritePermissions(strapi);
    await syncAdvancedSettings(strapi);
    // v0.27: the second factor seals its secrets with this service; refuse
    // to start without it rather than at the first enrollment.
    sealService(strapi);
    // v0.27: the per-request second-factor gate is in place (exactly one
    // decorated strategy in this boot), or no start; logs `[mfa] gate installed`.
    assertMfaGate(strapi.log);
    // D-ENTRA-01 spec L, on every boot and whether Entra is on or off: the
    // (tenant, object id) unique index (a failure is logged, and fatal only
    // with Entra on), grant.email = local sign-in on, grant.microsoft off,
    // then one `[entra] disabled|enabled …` line. The public
    // forgot/reset-password revocation is part of the permission sync above.
    const entra = parseEntraConfig(process.env);
    await ensureEntraIdentityIndex(strapi, { entraEnabled: entra.enabled });
    await syncAuthProviders(strapi, entra);
    reportEntraStatus(strapi.log, entra);
    // v0.25.0: the OIDC identity's unique index (fatal only with OIDC on),
    // one `[oidc] disabled|enabled …` line and, with OIDC on, a discovery check.
    const oidc = parseOidcConfig(process.env);
    await ensureOidcIdentityIndex(strapi, { oidcEnabled: oidc.enabled });
    // v0.27: one account per e-mail address, case-insensitive (invitations rely on it).
    await ensureEmailIndex(strapi);
    await reportOidcStatus(strapi.log, oidc);
    strapi.log.info(searchStatusLine(parseMeiliConfig(process.env)));
    // v0.26 release identity: info.version is apps/cms/package.json (Strapi
    // loads it as config `info`); the image sets SINNLOS_REVISION at build.
    strapi.log.info(
      `[sinnlos] version ${strapi.config.get("info.version")} (revision ${process.env.SINNLOS_REVISION || "unknown"})`,
    );
    // Decision 02: give existing polls their `audience` flag ('departments'
    // when they link a department). A no-op once no row is NULL. One
    // transaction; on any error it rolls back and THROWS, so the cms does
    // not start with a restricted poll left open (fail closed, see
    // utils/poll-audience-backfill.ts). Before the draft-twin repair below,
    // so a cloned draft copies the flag.
    await backfillPollAudience(strapi);
    // FX29 residual (B12-01): every document and quick-link row that links a
    // department gets audience='departments' (raise only; later boots find
    // nothing). One transaction; on any error it rolls back and THROWS, so
    // the cms does not start (utils/department-audience-backfill.ts).
    // Before the demo seed and the draft-twin repair, like the poll one.
    await backfillDepartmentAudience(strapi);
    // Decision 06 §N9 (amendment row A5): announcement `audience` and event
    // `notifyAudience` raised on every row that links a target, NULL event
    // rows set, and the twin rule after a rollback (a NULL notifyAudience or
    // retargetRequired takes the other row's restricting value). Raise
    // only; one transaction; THROWS on error, so the cms does not start
    // (utils/targeting-flags-backfill.ts). Before the seed and the draft
    // twins, so a cloned draft copies the repaired value.
    await backfillTargetingFlags(strapi);
    // Batch 16 (DA03): wiki revisions get their page anchor and kind, and
    // every page whose draft or published content no snapshot holds gets a
    // `baseline` revision (the cutover: the first boot of batch 16, and every
    // boot after a rollback window). One transaction; THROWS on error, so no
    // page is saved before its baseline exists (utils/revision-backfill.ts).
    // Before the seed and the draft twins: their draft creates then find the
    // baseline and record nothing.
    await backfillRevisions(strapi);
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
