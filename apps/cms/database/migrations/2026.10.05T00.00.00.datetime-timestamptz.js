"use strict";

/**
 * One-time datetime repair and conversion to timestamptz (datetime contract,
 * deep-dive decision 04, C11). A Strapi user migration: @strapi/database
 * 5.55.1 discovers <app root>/database/migrations/*.js (migrations/users.js,
 * discover.js), runs it inside one transaction (migrations/common.js:3-5)
 * before its internal migrations and before schema sync
 * (migrations/index.js:21-27, schema/index.js:73-78), and records it in
 * strapi_migrations afterwards, so it runs once per database. A failure
 * rolls the transaction back and stops the boot.
 *
 * On a database without naive timestamp columns (every fresh install: the
 * tables do not exist yet at this point) it does nothing. Otherwise it needs
 * DATETIME_LEGACY_ZONE (and optionally DATETIME_LEGACY_UTC_UNTIL); see
 * src/database/datetime-legacy.ts for the rules and docs/DEPLOYMENT.md for
 * the operator steps.
 *
 * Plain CommonJS because the runner require()s the file; the logic is
 * TypeScript, compiled with the rest of the cms into dist/.
 */
const path = require("node:path");

function loadRepair() {
  const strapiInstance = global.strapi;
  const distSrc =
    (strapiInstance && strapiInstance.dirs && strapiInstance.dirs.dist && strapiInstance.dirs.dist.src) ||
    path.join(__dirname, "..", "..", "dist", "src");
  return require(path.join(distSrc, "database", "datetime-legacy.js"));
}

module.exports = {
  async up(trx, db) {
    const log = (global.strapi && global.strapi.log) || console;
    await loadRepair().runLegacyDatetimeMigration(trx, db, { env: process.env, log });
  },

  async down() {
    throw new Error(
      "The datetime repair is not reversible in place: restore the pre-deploy database dump instead " +
        "(the old values are also kept in datetime_migration_audit).",
    );
  },
};
