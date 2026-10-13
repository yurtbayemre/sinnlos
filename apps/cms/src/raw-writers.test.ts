import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as authoringUids from "./utils/authoring-uids";
import { GUARDED_UIDS } from "./utils/authoring-uids";

/**
 * Raw writers of guarded documents (decision 06 §G "Rule"; batch 15 plan
 * item 8; append-only like poll-exposure.test.ts, filled in merge order).
 *
 * Every content write of a guarded type (utils/authoring-uids.ts
 * GUARDED_UIDS) goes through the Document Service, where the document lock
 * advances its revision, OR runs under the document's lock and advances
 * the revision itself, OR only raises a targeting flag (a raised flag only
 * restricts, so it needs no revision). Any other raw writer would evade the
 * `If-Match` check: a web form would overwrite its change unseen.
 *
 * This file is the containment. It finds every module that reaches the
 * query layer (`db.query(…)`, the query builder, knex) AND has a write
 * call in it, and requires each to be listed here exactly once:
 *   - GUARDED_RAW_WRITERS: it writes rows of a guarded type outside the
 *     Document Service; the entry names the §G rule it satisfies;
 *   - OTHER_RAW_WRITERS: it writes only rows of other types (or writes
 *     guarded types only through the Document Service); the entry says
 *     what it writes.
 * A new module of either kind fails the inventory until it is reviewed and
 * listed. 15D and 15A append the rows of their own files.
 */

type GuardRule =
  | "raises a flag only"
  | "under the lock with a revision advance"
  | "boot backfill, raise only"
  | "boot seed of a fresh database";

const GUARDED_RAW_WRITERS: Readonly<Record<string, { rule: GuardRule; writes: string }>> = {
  "cron/scheduled-publish.ts": {
    rule: "under the lock with a revision advance",
    writes:
      "the scheduler's claim (publishAt / unpublishAt) and its failure and expired-window writes " +
      "(scheduleError), each after lockDocument with the generation check, then advanceRevision " +
      "or the Document Service publish/unpublish (§D rules 4, 5, 7)",
  },
  "utils/schedule.ts": {
    rule: "under the lock with a revision advance",
    writes:
      "schedule-clear's updateMany of the draft's publishAt/scheduleError, a Document Service " +
      "middleware inside the document lock, which advances the revision after the action",
  },
  "utils/poll-audience-guard.ts": {
    rule: "raises a flag only",
    writes:
      "audience='departments' on poll rows that link a department (createAudienceGuard), and on " +
      "document and quick-link rows through department-audience-guard.ts",
  },
  "utils/poll-department-delete.ts": {
    rule: "raises a flag only",
    writes: "the poll audience flag before a department delete cascades its links",
  },
  "utils/department-delete-restrict.ts": {
    rule: "raises a flag only",
    writes:
      "the document and quick-link audience flag before a department delete, and in the boot " +
      "backfill through department-audience-backfill.ts (restrictRowsLinking)",
  },
  "utils/poll-audience-backfill.ts": {
    rule: "boot backfill, raise only",
    writes: "the poll audience flag of NULL rows, with the twin rule",
  },
  "utils/targeting-flags-backfill.ts": {
    rule: "boot backfill, raise only",
    writes:
      "announcement audience and event notifyAudience on linked rows, NULL event rows, and the " +
      "twin rule for notifyAudience and retargetRequired",
  },
  "utils/targeting-flags.ts": {
    rule: "raises a flag only",
    writes:
      "announcement audience and event notifyAudience on linked rows (the write-time guard, " +
      "inside the document lock), and before a department or team delete the announcement " +
      "audience + retargetRequired and the event notifyAudience; the delete hooks first lock and " +
      "advance (lockDocument, advanceRevision) every announcement, event and document linking " +
      "the deleted row, ascending (§D rule 13)",
  },
  "seed-demo.ts": {
    rule: "boot seed of a fresh database",
    writes:
      "the demo departments and teams (db.query create, then the departments' heads), before the " +
      "server listens and only on an empty database; their revision starts at 0",
  },
};

const OTHER_RAW_WRITERS: Readonly<Record<string, string>> = {
  "api/acknowledgement/controllers/acknowledgement.ts": "acknowledgements",
  "api/classified/content-types/classified/lifecycles.ts": "comment only (uploads of classifieds)",
  "api/classified/controllers/classified.ts":
    "classifieds through the Document Service (super.create, update, delete)",
  "api/comment/content-types/comment/lifecycles.ts": "notifications",
  "api/department/content-types/department/lifecycles.ts":
    "comment only: the flags and revisions go through targeting-flags.ts, " +
    "department-delete-restrict.ts and poll-department-delete.ts",
  "api/department/controllers/department.ts":
    "department writes only through the Document Service (super.update)",
  "api/event-rsvp/controllers/event-rsvp.ts": "RSVPs",
  "api/kudos/content-types/kudos/lifecycles.ts": "notifications",
  "api/kudos/controllers/kudos.ts": "kudos through the Document Service (super.create)",
  "api/lesson-progress/controllers/lesson-progress.ts": "lesson progress rows",
  "api/notification/controllers/notification.ts": "notifications (read state)",
  "api/poll-vote/controllers/poll-vote.ts": "poll votes (the poll row itself is never written)",
  "api/profile/controllers/profile.ts": "users",
  "api/reaction/controllers/reaction.ts": "reactions",
  "api/search-log/controllers/search-log.ts": "search logs",
  "api/team/controllers/team.ts": "team writes only through the Document Service (super.update)",
  "api/wiki-page/content-types/wiki-page/lifecycles.ts": "wiki revisions (not a guarded type)",
  "bootstrap/sync-permissions.ts": "roles and permissions",
  "cron/prune-audit-events.ts": "audit events (the retention janitor)",
  "cron/prune-notifications.ts": "notifications",
  "cron/prune-search-logs.ts": "search logs",
  "cron/purge-expired-classifieds.ts": "classifieds through the Document Service",
  "digest/send-digests.ts": "users (lastDigestAt)",
  "entra/provision.ts": "users (the Entra sign-in)",
  "extensions/upload/strapi-server.ts": "upload files",
  "extensions/users-permissions/strapi-server.ts": "users (the token version)",
  "utils/audit.ts": "audit events (the recorder)",
  "utils/document-lock.ts": "content_versions, the revision rows themselves",
  "utils/draft-twins.ts": "comment only: the repair writes through documents.discardDraft",
  "utils/live-events.ts": "comment only",
  "utils/notify.ts": "notifications",
  "utils/target-visibility.ts": "none (Set.delete); reads only",
  "utils/visible-ids.ts": "none (Map.delete); reads only",
};

const SRC = __dirname;

/** Non-test .ts files under `dir`, as paths relative to src with `/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test") continue;
      out.push(...sourceFiles(path));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.helper.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(relative(SRC, path).split("\\").join("/"));
    }
  }
  return out;
}

/** Reaches the query layer: the query engine, the query builder or knex. */
const QUERY_LAYER =
  /db\s*\.\s*query\(|strapi\s*\.\s*query\(|queryBuilder\(|getConnection\(|connection\.raw\(|\.connection\(/;

/** The uid constants of utils/authoring-uids.ts, by exported name. */
const UID_CONSTANTS: ReadonlyMap<string, string> = new Map(
  (Object.entries(authoringUids) as Array<[string, unknown]>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].startsWith("api::"),
  ),
);

const WRITE_METHODS = "create|createMany|update|updateMany|delete|deleteMany";
const QUERY_CALL = String.raw`(?:db\s*\.\s*query|strapi\s*\.\s*query)\(\s*([^()]+?)\s*\)`;

/**
 * The uids a module writes raw through the query engine: `db.query(<uid>)`
 * or `strapi.query(<uid>)` followed by a write method, directly or through a
 * `const` that holds the query. `<uid>` is a string literal, a `const` of
 * the module, or a uid constant of utils/authoring-uids.ts.
 */
function rawWrittenUids(source: string): string[] {
  const constants = new Map<string, string>(UID_CONSTANTS);
  for (const match of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*["']([^"']+)["']/g,
  )) {
    constants.set(match[1], match[2]);
  }
  const resolve = (argument: string): string | null => {
    const trimmed = argument.trim();
    const literal = /^["']([^"']+)["']$/.exec(trimmed);
    if (literal) return literal[1];
    return constants.get(trimmed) ?? null;
  };
  const written = new Set<string>();
  const direct = new RegExp(String.raw`${QUERY_CALL}\s*\.\s*(?:${WRITE_METHODS})\(`, "g");
  for (const match of source.matchAll(direct)) {
    const uid = resolve(match[1]);
    if (uid) written.add(uid);
  }
  const held = new RegExp(
    String.raw`\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*${QUERY_CALL}`,
    "g",
  );
  for (const match of source.matchAll(held)) {
    const uid = resolve(match[2]);
    const writes = new RegExp(String.raw`\b${match[1]}\s*\.\s*(?:${WRITE_METHODS})\(`);
    if (uid && writes.test(source)) written.add(uid);
  }
  return [...written].sort();
}

/** A write call of the query engine or knex (also caught in comments: listed, reviewed). */
const WRITE_CALL =
  /updateMany|deleteMany|createMany|\.insert\(|\.del\(|\.update\(|\.delete\(|\.create\(|raw\(\s*[`"'](?:UPDATE|DELETE|INSERT)/i;

describe("raw writers (inventory, decision 06 §G Rule)", () => {
  const candidates = sourceFiles(SRC)
    .filter((file) => {
      const source = readFileSync(join(SRC, file), "utf8");
      return QUERY_LAYER.test(source) && WRITE_CALL.test(source);
    })
    .sort();

  it("lists every module that writes through the query layer, each reviewed once", () => {
    const listed = [...Object.keys(GUARDED_RAW_WRITERS), ...Object.keys(OTHER_RAW_WRITERS)].sort();
    expect(new Set(listed).size, "a module listed twice").toBe(listed.length);
    expect(candidates).toEqual(listed);
  });

  it("names a §G rule for every raw writer of a guarded type", () => {
    for (const [file, { rule, writes }] of Object.entries(GUARDED_RAW_WRITERS)) {
      expect(
        [
          "raises a flag only",
          "under the lock with a revision advance",
          "boot backfill, raise only",
          "boot seed of a fresh database",
        ],
        file,
      ).toContain(rule);
      expect(writes.length, file).toBeGreaterThan(10);
    }
  });

  it("the writers 'under the lock' take it and advance the revision", () => {
    for (const [file, { rule }] of Object.entries(GUARDED_RAW_WRITERS)) {
      if (rule !== "under the lock with a revision advance") continue;
      const source = readFileSync(join(SRC, file), "utf8");
      if (file === "utils/schedule.ts") {
        // A Document Service middleware: the lock wraps it (slot 2 before slot 5).
        expect(source, file).toMatch(/createScheduleClear/);
        continue;
      }
      expect(source, file).toMatch(/lockDocument\(/);
      expect(source, file).toMatch(/advanceRevision\(/);
    }
  });

  it("finds raw writes through literals and constants (the check below is not vacuous)", () => {
    expect(
      rawWrittenUids(readFileSync(join(SRC, "seed-demo.ts"), "utf8")).filter((uid) =>
        GUARDED_UIDS.includes(uid),
      ),
    ).toEqual(["api::department.department", "api::team.team"]);
    expect(
      rawWrittenUids(
        'const T = "api::team.team";\nconst q = strapi.db.query(T);\nawait q.updateMany({});\n' +
          "await strapi.query(ANNOUNCEMENT_UID).delete({});",
      ),
    ).toEqual(["api::announcement.announcement", "api::team.team"]);
  });

  it("a module listed as writing other types writes no guarded uid raw", () => {
    for (const file of Object.keys(OTHER_RAW_WRITERS)) {
      const written = rawWrittenUids(readFileSync(join(SRC, file), "utf8"));
      expect(
        written.filter((uid) => GUARDED_UIDS.includes(uid)),
        `${file} writes a guarded type raw: list it with its §G rule`,
      ).toEqual([]);
    }
  });
});
