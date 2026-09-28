import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { targetUid } from "./utils/comment-target";
import { __flushLiveEventsForTest, registerLiveEventSubscriber } from "./utils/live-events";
import { RESTRICTED_RELATION_TARGETS, isRestrictedRelation } from "./utils/restricted-relations";

/**
 * Every path by which a poll (question, options, results) could reach a
 * guest, pinned (owner decision 2026-09-27: polls are hidden from guests
 * unless an admin or editor sets `visibleToGuests`; utils/poll-audience.ts).
 *
 * The enforcing paths are tested where they live: the poll list and detail
 * in policies/poll-visibility.test.ts, vote and results in
 * api/poll-vote/controllers/poll-vote.test.ts, the relation guard in
 * utils/restricted-relations.test.ts and routes.matrix.test.ts. This file
 * pins that no OTHER path exists:
 *   - the consumer inventory: every cms module that names the poll or
 *     poll-vote content type is listed below with the reason it cannot hand
 *     a poll to a guest; a new consumer (a notification, a digest section, a
 *     dashboard endpoint, a search index) fails this test until it is
 *     reviewed and decides through utils/poll-audience.ts,
 *   - notifications: no notification type or source is a poll, poll votes
 *     have no lifecycle, and the poll lifecycle only validates `options`
 *     before a write (FX20), so none can fan one out,
 *   - comments, reactions and read receipts cannot anchor on a poll,
 *   - live (SSE) pings: poll and poll-vote writes emit nothing, and the
 *     pings carry no content anyway (utils/live-events.ts; the channels of
 *     utils/live-contract.ts are the comment targets, no poll among them),
 *   - e-mail digests read no polls,
 *   - relations: only poll-vote.poll points at a poll (no content-API
 *     route, and the relation guard trusts no source into polls), and the
 *     user model (/api/users, /api/users/me) has no relation into polls or
 *     votes at all.
 * Generic modules that touch every content type without naming polls
 * (draft-twins.ts, the datetime repair, the restricted-relation guard, the
 * contact-field sanitizer) never serve rows to a caller.
 */

const SRC = __dirname;
const API_DIR = join(SRC, "api");
const POLL_UID = "api::poll.poll";
const POLL_VOTE_UID = "api::poll-vote.poll-vote";

/** Names the poll or poll-vote uid, or the POLL_UID constant of poll-access.ts. */
const POLL_REFERENCE = /api::poll\.poll\b|api::poll-vote\.poll-vote\b|\bPOLL_UID\b/;

/**
 * Reviewed consumers (path under apps/cms/src → why a guest cannot get a
 * hidden poll through it). Keep the reason honest: "decides through
 * canSeePoll/canVoteOnPoll", "admin/editor only", "writes flags only" or
 * "internal, no response".
 */
const REVIEWED_CONSUMERS: Readonly<Record<string, string>> = {
  "api/poll/controllers/poll.ts":
    "core find/findOne behind global::poll-visibility (canSeePoll); create (admin/editor) pins the author",
  "api/poll/routes/poll.ts": "find/findOne: global::poll-visibility; writes: admin/editor only",
  "api/poll/services/poll.ts": "core service, reached only through the routes above",
  "api/poll-vote/controllers/poll-vote.ts": "vote/results: canSeePoll 404, canVoteOnPoll 403",
  "api/poll-vote/routes/custom-poll-vote.ts": "the vote/results routes of the controller above",
  "api/poll-vote/routes/poll-vote.ts": "core router with `only: []`: no generic /api/poll-votes route",
  "api/poll-vote/services/poll-vote.ts": "core service without a route",
  "bootstrap/permission-matrix.ts":
    "permission matrix and grants (enforcement is in the rules, not the grants)",
  "policies/poll-visibility.ts": "the list/detail filter: canSeePoll per published row",
  "seed-demo.ts": "internal demo seed, no response",
  "utils/poll-access.ts": "loaders for the policy and the controller",
  "utils/poll-audience-backfill.ts": "boot backfill of `audience`, writes flags only",
  "utils/poll-audience-guard.ts": "write-time `audience` guard, writes flags only",
  "utils/poll-ballots.ts":
    "the results count (FX20), called by the results handler after canSeePoll; counts only, no voter",
  "utils/poll-department-delete.ts": "department delete hook, writes `audience` only",
  "utils/restricted-relations.ts": "FX05 guard: no source is trusted into polls",
};

/** Non-test .ts files under `dir`, as paths relative to src with `/`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test.helper.ts")) {
      out.push(relative(SRC, path).split("\\").join("/"));
    }
  }
  return out;
}

interface AttributeSchema {
  type: string;
  target?: string;
  enum?: string[];
}

interface ContentTypeSchema {
  attributes: Record<string, AttributeSchema>;
}

const readSchema = (file: string): ContentTypeSchema =>
  JSON.parse(readFileSync(file, "utf8")) as ContentTypeSchema;

/** uid → schema of every api content type plus the extended user. */
function schemas(): Map<string, ContentTypeSchema> {
  const out = new Map<string, ContentTypeSchema>();
  for (const api of readdirSync(API_DIR)) {
    const typesDir = join(API_DIR, api, "content-types");
    if (!existsSync(typesDir)) continue;
    for (const type of readdirSync(typesDir)) {
      const file = join(typesDir, type, "schema.json");
      if (existsSync(file)) out.set(`api::${api}.${type}`, readSchema(file));
    }
  }
  out.set(
    "plugin::users-permissions.user",
    readSchema(join(SRC, "extensions", "users-permissions", "content-types", "user", "schema.json")),
  );
  return out;
}

const SCHEMAS = schemas();
const schemaOf = (uid: string): ContentTypeSchema => {
  const schema = SCHEMAS.get(uid);
  if (!schema) throw new Error(`no schema for ${uid}`);
  return schema;
};

describe("poll consumers (inventory)", () => {
  const consumers = sourceFiles(SRC)
    .filter((file) => POLL_REFERENCE.test(readFileSync(join(SRC, file), "utf8")))
    .sort();

  it("lists every module that names polls or poll votes, each reviewed for guests", () => {
    expect(consumers).toEqual(Object.keys(REVIEWED_CONSUMERS).sort());
  });

  it("has no notification, digest, cron or live-event module among them", () => {
    for (const prefix of [
      "api/notification/",
      "digest/",
      "cron/",
      "utils/live-events",
      "utils/live-contract",
      "utils/notification-source",
    ]) {
      expect(consumers.filter((file) => file.startsWith(prefix)), prefix).toEqual([]);
    }
  });
});

describe("notifications", () => {
  it("have no poll type and no poll source", () => {
    const { attributes } = schemaOf("api::notification.notification");
    expect(attributes.type.enum).not.toContain("poll");
    expect(attributes.sourceType.enum).not.toContain("poll");
    for (const values of [attributes.type.enum ?? [], attributes.sourceType.enum ?? []]) {
      expect(values.filter((value) => value.includes("poll"))).toEqual([]);
    }
  });

  it("cannot be fanned out by a poll or vote lifecycle: votes have none, polls only validate", async () => {
    expect(readdirSync(join(API_DIR, "poll-vote/content-types/poll-vote")).sort()).toEqual([
      "schema.json",
    ]);
    expect(readdirSync(join(API_DIR, "poll/content-types/poll")).sort()).toEqual([
      "lifecycles.test.ts",
      "lifecycles.ts",
      "schema.json",
    ]);
    // FX20: the options check runs before the write; no after* hook, and it
    // imports nothing but the pure rules.
    const { default: hooks } = await import("./api/poll/content-types/poll/lifecycles");
    expect(Object.keys(hooks).sort()).toEqual(["beforeCreate", "beforeUpdate"]);
    const source = readFileSync(join(API_DIR, "poll/content-types/poll/lifecycles.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(imports).toEqual([
      "../../../../utils/json-field",
      "../../../../utils/poll-options",
      "@strapi/utils",
    ]);
  });
});

describe("comments, reactions and read receipts", () => {
  it("cannot anchor on a poll", () => {
    for (const uid of ["api::comment.comment", "api::reaction.reaction", "api::acknowledgement.acknowledgement"]) {
      const values = schemaOf(uid).attributes.targetType.enum ?? [];
      expect(values.filter((value) => value.includes("poll")), uid).toEqual([]);
    }
    expect(targetUid("poll")).toBeNull();
  });
});

describe("live (SSE) pings", () => {
  const fetchMock = vi.fn();
  type Handler = (event: unknown) => Promise<void>;
  /** Function or object form (utils/live-events.ts subscribes in object form, LF06). */
  type Subscriber = Handler | ({ models?: string[] } & Record<string, unknown>);

  /** Dispatches one event the way @strapi/database 5.55.1 does (lifecycles/index.js run). */
  async function dispatch(
    subscriber: Subscriber,
    event: { model: { uid: string }; action: string } & Record<string, unknown>,
  ): Promise<void> {
    if (typeof subscriber === "function") return subscriber(event);
    if (!(event.action in subscriber)) return;
    if (subscriber.models && !subscriber.models.includes(event.model.uid)) return;
    const handler = subscriber[event.action];
    if (typeof handler === "function") await (handler as Handler)(event);
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    vi.stubEnv("WEB_INTERNAL_URL", "http://web:3000");
    vi.stubEnv("REVALIDATE_SECRET", "test-secret");
    vi.stubEnv("LIVE_EVENTS_DISABLED", "");
  });

  afterEach(async () => {
    await __flushLiveEventsForTest();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("are not sent for poll or vote writes", async () => {
    let subscriber: Subscriber | undefined;
    const strapi = {
      db: {
        lifecycles: { subscribe: (fn: Subscriber) => (subscriber = fn) },
        query: () => ({ findOne: async () => null }),
      },
      log: { info: () => {}, warn: () => {} },
    };
    registerLiveEventSubscriber(strapi);
    if (!subscriber) throw new Error("no subscriber registered");

    const row = {
      id: 7,
      documentId: "p-hidden",
      question: "Hidden from guests?",
      publishedAt: "2026-09-27T10:00:00.000Z",
      visibleToGuests: false,
    };
    for (const uid of [POLL_UID, POLL_VOTE_UID]) {
      for (const action of ["afterCreate", "afterUpdate", "afterDelete", "afterCreateMany", "afterUpdateMany"]) {
        await dispatch(subscriber, { model: { uid }, action, result: row, params: { data: row } });
      }
    }
    await __flushLiveEventsForTest();
    expect(fetchMock).not.toHaveBeenCalled();

    // Control: the same stub does emit for a watched type, and the ping is
    // content-free (a channel, never a title or a question).
    await dispatch(subscriber, {
      model: { uid: "api::announcement.announcement" },
      action: "afterCreate",
      result: { id: 1, title: "News", publishedAt: row.publishedAt },
    });
    await __flushLiveEventsForTest();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ events: [{ kind: "announcements" }] });
  });
});

describe("relations into polls", () => {
  const relationsInto = (target: string) =>
    [...SCHEMAS].flatMap(([uid, schema]) =>
      Object.entries(schema.attributes)
        .filter(([, attr]) => attr.type === "relation" && attr.target === target)
        .map(([name]) => `${uid}.${name}`),
    );

  it("come from poll-vote.poll alone, and nothing points at a vote", () => {
    expect(relationsInto(POLL_UID)).toEqual(["api::poll-vote.poll-vote.poll"]);
    expect(relationsInto(POLL_VOTE_UID)).toEqual([]);
  });

  it("are cut by the relation guard for every source (no trusted source into polls)", () => {
    expect(RESTRICTED_RELATION_TARGETS[POLL_UID]).toEqual([]);
    const attr = schemaOf(POLL_VOTE_UID).attributes.poll;
    expect(isRestrictedRelation({ uid: POLL_VOTE_UID }, attr, RESTRICTED_RELATION_TARGETS)).toBe(true);
  });

  it("do not start at the user model: /api/users cannot populate a poll or a vote", () => {
    const targets = Object.values(schemaOf("plugin::users-permissions.user").attributes)
      .filter((attr) => attr.type === "relation")
      .map((attr) => attr.target);
    expect(targets).not.toContain(POLL_UID);
    expect(targets).not.toContain(POLL_VOTE_UID);
  });
});
