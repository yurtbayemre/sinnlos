import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the draftAndPublish flag of every content type.
 *
 * Flipping this flag is a data migration, and Strapi runs it on its own at
 * the next boot (@strapi/core 5.55.1 dist/migrations/draft-publish.js,
 * hooked in by providers/registries.js:31-33):
 *   - true → false: in the `content-types.beforeSync` hook, before schema
 *     sync and before any user migration in database/migrations, Strapi runs
 *     `DELETE FROM <table> WHERE published_at IS NULL` with no transaction
 *     around it. Documents that were never published disappear, the link
 *     rows of every draft go with them (FK ON DELETE CASCADE), and media
 *     rows in files_related_mph are left pointing at ids that no longer
 *     exist.
 *   - false → true: in the `afterSync` hook, every entry gets a draft clone
 *     (discardDraft per document).
 * So a flip needs a migration plan, not just a schema edit: see the
 * department/team switch (a register() guard that refuses to boot while
 * drafts exist, plus one-time SQL, infra/migrations/org-dp/README.md).
 * Change a flag and its entry here in the same commit.
 */

const API_DIR = join(__dirname, "api");
const USER_SCHEMA_FILE = join(
  __dirname,
  "extensions",
  "users-permissions",
  "content-types",
  "user",
  "schema.json",
);
const USER_UID = "plugin::users-permissions.user";

/** uid → options.draftAndPublish. Every content type must be listed. */
const DRAFT_AND_PUBLISH: Readonly<Record<string, boolean>> = {
  "api::acknowledgement.acknowledgement": false,
  "api::announcement.announcement": true,
  "api::classified.classified": false,
  "api::comment.comment": false,
  "api::course.course": true,
  // Single-row org master data (invariant I-ORG): one row per document with
  // a stable id, which the numeric org-scope comparisons rely on. Guarded at
  // boot by utils/org-dp-guard.ts; existing databases migrate with
  // infra/migrations/org-dp/migrate.sql.
  "api::department.department": false,
  "api::document.document": true,
  "api::event.event": true,
  "api::event-rsvp.event-rsvp": false,
  "api::kudos.kudos": false,
  "api::lesson.lesson": true,
  "api::lesson-progress.lesson-progress": false,
  "api::notification.notification": false,
  "api::poll.poll": true,
  "api::poll-vote.poll-vote": false,
  "api::quick-link.quick-link": true,
  "api::reaction.reaction": false,
  "api::search-log.search-log": false,
  // Same as department (I-ORG).
  "api::team.team": false,
  "api::wiki-page.wiki-page": true,
  "api::wiki-revision.wiki-revision": true,
  "api::wiki-space.wiki-space": true,
  [USER_UID]: false,
};

interface SchemaOptions {
  options?: { draftAndPublish?: unknown };
}

function readSchema(file: string): SchemaOptions {
  return JSON.parse(readFileSync(file, "utf8")) as SchemaOptions;
}

/** Every content-type schema of the app, keyed by uid. */
function loadSchemas(): Map<string, SchemaOptions> {
  const schemas = new Map<string, SchemaOptions>();
  for (const api of readdirSync(API_DIR)) {
    const typesDir = join(API_DIR, api, "content-types");
    if (!existsSync(typesDir)) continue; // routes-only APIs (profile)
    for (const name of readdirSync(typesDir)) {
      const file = join(typesDir, name, "schema.json");
      if (existsSync(file)) schemas.set(`api::${api}.${name}`, readSchema(file));
    }
  }
  schemas.set(USER_UID, readSchema(USER_SCHEMA_FILE));
  return schemas;
}

describe("draftAndPublish flags (flipping one is a boot-time data migration)", () => {
  const schemas = loadSchemas();

  it("finds the app's content types", () => {
    expect(schemas.size).toBeGreaterThanOrEqual(23);
  });

  it("pins every content type, and only existing ones", () => {
    const found = [...schemas.keys()].sort();
    const pinned = Object.keys(DRAFT_AND_PUBLISH).sort();
    expect(
      found.filter((uid) => !pinned.includes(uid)),
      "unpinned content types",
    ).toEqual([]);
    expect(
      pinned.filter((uid) => !found.includes(uid)),
      "pins without a schema",
    ).toEqual([]);
  });

  for (const [uid, schema] of schemas) {
    const expected = DRAFT_AND_PUBLISH[uid];
    it(`${uid} states draftAndPublish: ${String(expected)}`, () => {
      // Strapi treats a missing flag as false (domain/content-type/index.js
      // addDraftAndPublish); an explicit boolean keeps the intent visible.
      expect(typeof schema.options?.draftAndPublish, uid).toBe("boolean");
      expect(schema.options?.draftAndPublish, uid).toBe(expected);
    });
  }
});
