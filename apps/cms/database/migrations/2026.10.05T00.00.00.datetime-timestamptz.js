"use strict";

/**
 * The datetime user migration (datetime contract, deep-dive decision 04). A
 * Strapi user migration: @strapi/database discovers <app root>/database/
 * migrations/*.js (migrations/users.js, discover.js), runs it inside one
 * transaction (migrations/common.js) before its internal migrations and
 * before schema sync, and records it in strapi_migrations afterwards, so it
 * runs once per database. A failure rolls the transaction back and stops
 * the boot.
 *
 * Until v0.28 it repaired the wall clocks of pre-contract releases. Since
 * v0.29 (upgrade floor v0.25.x, where it has run) it only refuses a
 * database that still holds them: upgrade through v0.28.x first. On a fresh
 * install it does nothing and is recorded, which the timestamptz guard's
 * interlock needs (src/database/datetime-catalog.ts).
 *
 * Plain CommonJS because the runner require()s the file; the logic is
 * TypeScript, compiled with the rest of the cms into dist/.
 */
const path = require("node:path");

function loadCatalog() {
  const strapiInstance = global.strapi;
  const distSrc =
    (strapiInstance &&
      strapiInstance.dirs &&
      strapiInstance.dirs.dist &&
      strapiInstance.dirs.dist.src) ||
    path.join(__dirname, "..", "..", "dist", "src");
  return require(path.join(distSrc, "database", "datetime-catalog.js"));
}

module.exports = {
  async up(trx, db) {
    const log = (global.strapi && global.strapi.log) || console;
    await loadCatalog().refuseLegacyDatetimeData(trx, db, log);
  },

  async down() {
    // Nothing to undo: the migration changes nothing.
  },
};
