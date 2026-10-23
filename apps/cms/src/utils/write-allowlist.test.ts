import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS,
  ANNOUNCEMENT_MODERATOR_FIELDS,
  DOCUMENT_DEPARTMENT_AUTHOR_FIELDS,
  DOCUMENT_MODERATOR_FIELDS,
  EVENT_DEPARTMENT_AUTHOR_FIELDS,
  EVENT_MODERATOR_FIELDS,
  POLL_MODERATOR_FIELDS,
  QUICK_LINK_MODERATOR_FIELDS,
  WIKI_FIELDS,
  TRAINING_FIELDS,
  ORG_FIELDS,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";
import {
  DEPARTMENT_AUTHOR_CLASS,
  DEPARTMENT_UID,
  MAX_TAG_LENGTH,
  MODERATOR_CLASS,
  REFUSED_ATTRIBUTES,
  MAX_TAGS,
  MISSING_DATA_MESSAGE,
  SLUG_BASE_MAX_LENGTH,
  TEAM_UID,
  WIKI_PAGE_UID,
  WIKI_SPACE_UID,
  WRITE_ALLOWLIST,
  applyWriteRule,
  enforceWriteAllowlist,
  hasTargetId,
  parseToOneRelation,
  targetRowWhere,
  uniqueSlugFrom,
  valueChecks,
  writeAllowlistMessage,
  writeClassesFor,
  writeRuleFor,
  type RelationCheck,
  type RelationListCheck,
  type WriteRuleEnvironment,
  type RelationRef,
  type ResolvedToOne,
  type ToOneRelationInput,
  type WriteAllowlist,
  type WriteRule,
} from "./write-allowlist";
import { parseEntryRef } from "./entry-id";
import { MALFORMED_ENTRY_IDS, MALFORMED_ROW_IDS } from "./entry-id.test.helper";

/**
 * Field-level write allowlists (FX07), pure part: the relation input parser,
 * the value checks, the engine and the declarative table itself. The
 * Strapi-backed relation checks and the policies that call the engine are
 * covered in wiki-write-targets.test.ts and the policy tests.
 */

interface AttributeSchema {
  type: string;
  relation?: string;
  target?: string;
  mappedBy?: string;
  unique?: boolean;
}

const API_DIR = join(__dirname, "..", "api");

function schemaOf(uid: string): Record<string, AttributeSchema> {
  const [, rest] = uid.split("::");
  const [api, name] = rest.split(".");
  const file = join(API_DIR, api, "content-types", name, "schema.json");
  return JSON.parse(readFileSync(file, "utf8")).attributes;
}

async function refusal(
  promise: Promise<unknown>,
): Promise<InstanceType<typeof errors.ValidationError>> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(errors.ValidationError);
  return error as InstanceType<typeof errors.ValidationError>;
}

// ---------------------------------------------------------------------------
// Relation input shapes
// ---------------------------------------------------------------------------

describe("parseToOneRelation", () => {
  const set = (target: ToOneRelationInput["target"]): ToOneRelationInput => ({
    target,
    disconnect: [],
  });

  it.each<[string, unknown, ToOneRelationInput]>([
    ["null (clear)", null, set(null)],
    ["a raw numeric id", 5, set({ id: 5 })],
    ["a numeric string", "5", set({ id: 5 })],
    ["a documentId string", "k3x9page01", set({ documentId: "k3x9page01" })],
    ["{ id }", { id: 5 }, set({ id: 5 })],
    ["{ id } with a numeric string", { id: "5" }, set({ id: 5 })],
    ["the largest int4 id", 2147483647, set({ id: 2147483647 })],
    ["the largest int4 id as a string", "2147483647", set({ id: 2147483647 })],
    ["{ documentId }", { documentId: "k3x9page01" }, set({ documentId: "k3x9page01" })],
    ["a one-element array", [7], set({ id: 7 })],
    ["an array of one longhand", [{ documentId: "d1" }], set({ documentId: "d1" })],
    ["an empty array (clear)", [], set(null)],
    ["{ set: [ref] }", { set: [{ documentId: "d1" }] }, set({ documentId: "d1" })],
    ["{ set: ref }", { set: 9 }, set({ id: 9 })],
    ["{ set: [] } (clear)", { set: [] }, set(null)],
    ["{ connect: [ref] }", { connect: [{ id: 3 }] }, set({ id: 3 })],
    ["{ connect: ref }", { connect: "d2" }, set({ documentId: "d2" })],
    [
      "{ connect, disconnect }",
      { connect: [{ documentId: "d1" }], disconnect: [{ id: 4 }] },
      { target: { documentId: "d1" }, disconnect: [{ id: 4 }] },
    ],
    [
      "{ disconnect } only",
      { disconnect: [{ documentId: "d1" }, 4] },
      { target: undefined, disconnect: [{ documentId: "d1" }, { id: 4 }] },
    ],
    [
      "{ connect: [], disconnect: [] } (the admin panel's no-op)",
      { connect: [], disconnect: [] },
      { target: undefined, disconnect: [] },
    ],
  ])("accepts %s", (_label, input, expected) => {
    expect(parseToOneRelation(input)).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["true", true],
    ["false", false],
    ["zero", 0],
    ["a negative id", -1],
    ["a fractional id", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    // Beyond the int4 id columns: the Postgres lookup failed with a 500.
    ["an id beyond int4", 2147483648],
    ["a numeric string beyond int4", "2147483648"],
    ["{ id } beyond int4", { id: "99999999999" }],
    ["an empty string", ""],
    ["a zero-padded id (parseInt would read it)", "05"],
    ["a numeric prefix (parseInt would read it)", "12abc"],
    ["a signed numeric string", "-5"],
    ["a padded numeric string", " 5"],
    ["a documentId with whitespace", "ab c"],
    ["an overlong documentId", `a${"b".repeat(64)}`],
    ["an empty object", {}],
    ["an unknown key", { foo: 1 }],
    ["{ id } with a non-numeric id", { id: "abc" }],
    ["{ documentId } that parseInt reads as a number", { documentId: "123" }],
    ["{ documentId } with a number", { documentId: 5 }],
    ["{ id, documentId }", { id: 5, documentId: "d1" }],
    ["{ id, position }", { id: 5, position: { end: true } }],
    ["{ documentId, locale }", { documentId: "d1", locale: "en" }],
    ["{ documentId, status }", { documentId: "d1", status: "published" }],
    ["two targets in an array", [5, 6]],
    ["a nested array", [[5]]],
    ["a set payload inside an array", [{ set: [5] }]],
    ["{ set: null } (a silent no-op in Strapi)", { set: null }],
    ["{ set } with two targets", { set: [1, 2] }],
    ["{ set } mixed with connect", { set: [5], connect: [6] }],
    ["{ connect } with two targets", { connect: [1, 2] }],
    ["{ connect: null }", { connect: null }],
    ["{ disconnect: null }", { disconnect: null }],
    ["{ connect } with an unknown sibling key", { connect: [5], options: { strict: false } }],
    ["{ connect } with a positional entry", { connect: [{ id: 5, position: { start: true } }] }],
  ])("refuses %s", (_label, input) => {
    expect(parseToOneRelation(input)).toBeNull();
  });
});

describe("targetRowWhere / hasTargetId (the write policies' target row)", () => {
  it("reads a row id or a documentId like a relation ref", () => {
    expect(targetRowWhere("12")).toEqual({ id: 12 });
    expect(targetRowWhere(12)).toEqual({ id: 12 });
    expect(targetRowWhere("2147483647")).toEqual({ id: 2147483647 });
    expect(targetRowWhere("k3v9q2m8x7c4b1n6p5z0r2t8")).toEqual({
      documentId: "k3v9q2m8x7c4b1n6p5z0r2t8",
    });
  });

  it("is null without an id, which is a create for hasTargetId", () => {
    for (const idParam of [undefined, null, ""]) {
      expect(targetRowWhere(idParam)).toBeNull();
      expect(hasTargetId(idParam)).toBe(false);
    }
  });

  it("is null for a malformed or out-of-range id, which still names a target", () => {
    // Beyond int4 (or not an integer) the Postgres lookup failed with a 500.
    for (const idParam of [
      "2147483648",
      "99999999999999999999",
      "1.5",
      "1e3",
      "0",
      "05",
      "-1",
      " 1",
      "12abc",
      "a b",
    ]) {
      expect(targetRowWhere(idParam), idParam).toBeNull();
      expect(hasTargetId(idParam)).toBe(true);
    }
  });

  // PL01: parseEntryRef (every other id-addressed policy and controller)
  // and targetRowWhere share the row-id rule; the documentId rule of
  // targetRowWhere is wider (see its doc comment).
  it("reads every id parseEntryRef accepts the same way (parseEntryRef ⊆ targetRowWhere)", () => {
    for (const idParam of [1, 12, "12", "2147483647", "k3v9q2m8x7c4b1n6p5z0r2t8"]) {
      expect(parseEntryRef(idParam), String(idParam)).not.toBeNull();
      expect(targetRowWhere(idParam), String(idParam)).toEqual(parseEntryRef(idParam));
    }
  });

  it("refuses every malformed row id parseEntryRef refuses", () => {
    for (const idParam of MALFORMED_ROW_IDS) {
      expect(parseEntryRef(idParam), idParam).toBeNull();
      expect(targetRowWhere(idParam), idParam).toBeNull();
    }
  });

  it("differs only on documentIds Strapi never generates", () => {
    // parseEntryRef refuses these before any query; targetRowWhere looks
    // them up (a varchar comparison) and finds nothing.
    const wider = MALFORMED_ENTRY_IDS.filter((idParam) => targetRowWhere(idParam) !== null);
    expect(wider.length).toBeGreaterThan(0);
    for (const idParam of wider) {
      expect(parseEntryRef(idParam), idParam).toBeNull();
      expect(targetRowWhere(idParam), idParam).toEqual({ documentId: idParam });
      expect(MALFORMED_ROW_IDS, idParam).not.toContain(idParam);
    }
  });
});

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

describe("valueChecks", () => {
  it("hexColor accepts #rrggbb only", () => {
    for (const ok of ["#6366f1", "#ABCDEF", "#000000"])
      expect(valueChecks.hexColor(ok), ok).toBe(true);
    for (const bad of [
      "#abc",
      "#aabbccdd",
      "6366f1",
      "red",
      "url(https://x)",
      "#6366f1;",
      "#6366f1 ",
      "",
      null,
      0x6366f1,
    ]) {
      expect(valueChecks.hexColor(bad), String(bad)).toBe(false);
    }
  });

  it("requiredString needs a non-blank string of at most 255 characters", () => {
    expect(valueChecks.requiredString("Onboarding")).toBe(true);
    expect(valueChecks.requiredString("x".repeat(255))).toBe(true);
    expect(valueChecks.requiredString("x".repeat(256))).toBe(false);
    expect(valueChecks.requiredString("   ")).toBe(false);
    expect(valueChecks.requiredString(null)).toBe(false);
    expect(valueChecks.requiredString(5)).toBe(false);
  });

  it("nullableText takes a string or null", () => {
    expect(valueChecks.nullableText("")).toBe(true);
    expect(valueChecks.nullableText("# Heading")).toBe(true);
    expect(valueChecks.nullableText(null)).toBe(true);
    expect(valueChecks.nullableText(undefined)).toBe(false);
    expect(valueChecks.nullableText({ type: "doc" })).toBe(false);
    expect(valueChecks.nullableText(["a"])).toBe(false);
  });

  it("boolean and int32 are strict", () => {
    expect(valueChecks.boolean(true)).toBe(true);
    expect(valueChecks.boolean("true")).toBe(false);
    expect(valueChecks.boolean(1)).toBe(false);
    expect(valueChecks.int32(0)).toBe(true);
    expect(valueChecks.int32(-2147483648)).toBe(true);
    expect(valueChecks.int32(2147483647)).toBe(true);
    expect(valueChecks.int32(2147483648)).toBe(false);
    expect(valueChecks.int32(1.5)).toBe(false);
    expect(valueChecks.int32("3")).toBe(false);
  });

  it("tags is null or a short list of short, non-blank strings", () => {
    expect(valueChecks.tags(null)).toBe(true);
    expect(valueChecks.tags([])).toBe(true);
    expect(valueChecks.tags(["hr", "onboarding"])).toBe(true);
    expect(valueChecks.tags(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`))).toBe(true);
    expect(valueChecks.tags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toBe(false);
    expect(valueChecks.tags(["x".repeat(MAX_TAG_LENGTH + 1)])).toBe(false);
    expect(valueChecks.tags([" "])).toBe(false);
    expect(valueChecks.tags([1])).toBe(false);
    expect(valueChecks.tags({ a: 1 })).toBe(false);
    expect(valueChecks.tags("hr")).toBe(false);
  });
});

describe("uniqueSlugFrom", () => {
  const slugOf = (title: unknown) => uniqueSlugFrom("title")({ title }) as string;
  /** Strapi's uid character set, and at most 255 characters. */
  const UID = /^[A-Za-z0-9\-_.~]{1,255}$/;

  it("slugifies the title like the admin panel and appends 8 random hex digits", () => {
    expect(slugOf("Über uns: Größe & Maß")).toMatch(/^ueber-uns-groesse-and-mass-[0-9a-f]{8}$/);
    expect(slugOf("Onboarding 2026")).toMatch(/^onboarding-2026-[0-9a-f]{8}$/);
  });

  it("falls back to 'page' for a title that slugifies to nothing, or no title", () => {
    for (const title of ["写真", "🙂", "---", "", undefined, null, 42]) {
      expect(slugOf(title), String(title)).toMatch(/^page-[0-9a-f]{8}$/);
    }
  });

  it("caps the title part without leaving a dangling separator", () => {
    const slug = slugOf(`${"a".repeat(SLUG_BASE_MAX_LENGTH - 1)} b c`);
    expect(slug).toMatch(new RegExp(`^a{${SLUG_BASE_MAX_LENGTH - 1}}-[0-9a-f]{8}$`));
    expect(slugOf("x".repeat(255)).length).toBe(SLUG_BASE_MAX_LENGTH + 9);
  });

  it("always yields a valid uid, and a fresh suffix every time", () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const slug = slugOf("FAQ");
      expect(slug).toMatch(UID);
      slugs.add(slug);
    }
    expect(slugs.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe("applyWriteRule", () => {
  const CALLER = 42;

  const RULE: WriteRule = {
    fields: {
      title: { kind: "value", check: valueChecks.requiredString },
      space: { kind: "relation", check: "wikiSpace", required: true },
      parent: { kind: "relation", check: "wikiParent" },
      note: { kind: "controller", check: valueChecks.nullableText },
    },
    callerFields: ["author", "lastEditor"],
  };

  /** Resolves every ref to `doc-<id or documentId>`; records its calls. */
  function acceptingChecks() {
    const calls: {
      check: string;
      input: ToOneRelationInput;
      resolved: Record<string, ResolvedToOne>;
    }[] = [];
    const resolveAll =
      (check: string): RelationCheck =>
      async (input, resolved) => {
        calls.push({ check, input, resolved: { ...resolved } });
        const name = (ref: RelationRef) =>
          "id" in ref ? `doc-${ref.id}` : `doc-${ref.documentId}`;
        // null (clear) and undefined (unchanged) pass through as they are.
        const target: ResolvedToOne["target"] = input.target
          ? name(input.target)
          : (input.target as null | undefined);
        return { target, disconnect: input.disconnect.map(name) };
      };
    return {
      calls,
      checks: { wikiSpace: resolveAll("wikiSpace"), wikiParent: resolveAll("wikiParent") },
    };
  }

  it("refuses a missing or non-object data payload with the core's message", async () => {
    for (const data of [undefined, null, "x", [], 5]) {
      const error = await refusal(applyWriteRule(data, RULE, { callerId: CALLER }));
      expect(error.message).toBe(MISSING_DATA_MESSAGE);
    }
  });

  it("names every key outside the allowlist, sorted, in one message", async () => {
    const { checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule(
        { title: "T", space: "s1", pages: [1], members: { connect: [2] }, author: 9 },
        RULE,
        { callerId: CALLER, relationChecks: checks },
      ),
    );
    expect(error.message).toBe(writeAllowlistMessage(["author", "members", "pages"]));
    expect(error.details).toEqual({ keys: ["author", "members", "pages"] });
  });

  it("refuses the caller fields when the payload names them", async () => {
    const { checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule({ space: "s1", lastEditor: CALLER }, RULE, {
        callerId: CALLER,
        relationChecks: checks,
      }),
    );
    expect(error.message).toBe(writeAllowlistMessage(["lastEditor"]));
  });

  it("refuses Strapi's own keys and prototype-ish keys like any other", async () => {
    const data = JSON.parse(
      '{"space":"s1","id":1,"documentId":"x","publishedAt":null,"locale":"en","createdBy":1,' +
        '"__proto__":{"title":"x"},"constructor":1,"toString":1,"hasOwnProperty":1}',
    ) as Record<string, unknown>;
    const { checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule(data, RULE, { callerId: CALLER, relationChecks: checks }),
    );
    expect(error.details).toEqual({
      keys: [
        "__proto__",
        "constructor",
        "createdBy",
        "documentId",
        "hasOwnProperty",
        "id",
        "locale",
        "publishedAt",
        "toString",
      ],
    });
  });

  it("uses the same message for a refused value as for a refused key", async () => {
    const error = await refusal(
      applyWriteRule({ title: "  ", space: "s1" }, RULE, { callerId: CALLER }),
    );
    expect(error.message).toBe(writeAllowlistMessage(["title"]));
  });

  it("refuses a malformed relation shape without looking anything up", async () => {
    const { calls, checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule({ space: "s1", parent: [1, 2] }, RULE, {
        callerId: CALLER,
        relationChecks: checks,
      }),
    );
    expect(error.message).toBe(writeAllowlistMessage(["parent"]));
    expect(calls).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing", { title: "T" }],
    ["null", { space: null }],
    ["cleared", { space: { set: [] } }],
    ["disconnect-only", { space: { disconnect: ["s1"] } }],
    ["a connect/disconnect pair", { space: { connect: ["s1"], disconnect: ["s2"] } }],
    ["the no-op", { space: { connect: [], disconnect: [] } }],
  ])("refuses a required relation that is %s", async (_label, data) => {
    const { calls, checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule(data, RULE, { callerId: CALLER, relationChecks: checks }),
    );
    expect(error.message).toBe(writeAllowlistMessage(["space"]));
    expect(calls).toEqual([]);
  });

  it("runs relation checks in rule order, each seeing the earlier results", async () => {
    const { calls, checks } = acceptingChecks();
    // Payload order is parent first; the rule declares space first.
    await applyWriteRule({ parent: { connect: [7] }, space: { documentId: "s1" } }, RULE, {
      callerId: CALLER,
      relationChecks: checks,
    });
    expect(calls.map((c) => c.check)).toEqual(["wikiSpace", "wikiParent"]);
    expect(calls[1].resolved).toEqual({ space: { target: "doc-s1", disconnect: [] } });
    expect(calls[1].input).toEqual({ target: { id: 7 }, disconnect: [] });
  });

  it("stops at the first refused relation and names only that key", async () => {
    const { calls, checks } = acceptingChecks();
    const error = await refusal(
      applyWriteRule({ space: "hidden", parent: 7 }, RULE, {
        callerId: CALLER,
        relationChecks: { ...checks, wikiSpace: async () => null },
      }),
    );
    expect(error.message).toBe(writeAllowlistMessage(["space"]));
    expect(calls).toEqual([]);
  });

  it("rewrites relations to documentIds and forces the caller fields", async () => {
    const { checks } = acceptingChecks();
    const out = await applyWriteRule(
      { title: "T", space: 3, parent: { documentId: "p1" }, note: "typo" },
      RULE,
      { callerId: CALLER, relationChecks: checks },
    );
    expect(out).toEqual({
      title: "T",
      space: { set: [{ documentId: "doc-3" }] },
      parent: { set: [{ documentId: "doc-p1" }] },
      note: "typo",
      author: CALLER,
      lastEditor: CALLER,
    });
  });

  it("writes a clear as null, a disconnect as documentIds and drops a no-op", async () => {
    const { checks } = acceptingChecks();
    const base = { space: "s1" };
    const run = (parent: unknown) =>
      applyWriteRule({ ...base, parent }, RULE, { callerId: CALLER, relationChecks: checks });
    expect((await run(null)).parent).toBeNull();
    expect((await run({ set: [] })).parent).toBeNull();
    expect((await run({ disconnect: [5, "p2"] })).parent).toEqual({
      disconnect: [{ documentId: "doc-5" }, { documentId: "doc-p2" }],
    });
    expect("parent" in (await run({ connect: [], disconnect: [] }))).toBe(false);
    // A connect/disconnect pair on a to-one relation ends at the connected row.
    expect((await run({ connect: [5], disconnect: [6] })).parent).toEqual({
      set: [{ documentId: "doc-5" }],
    });
  });

  it("computes derived fields from the accepted payload and refuses them from the client", async () => {
    const seen: Record<string, unknown>[] = [];
    const derived: WriteRule = {
      ...RULE,
      derivedFields: {
        slug: (accepted) => {
          seen.push(accepted);
          return `slug-of-${String(accepted.title)}`;
        },
      },
    };
    const { checks } = acceptingChecks();
    const env = { callerId: CALLER, relationChecks: checks };
    const out = await applyWriteRule({ title: "T", space: "s1" }, derived, env);
    expect(out.slug).toBe("slug-of-T");
    expect(seen).toEqual([{ title: "T", space: { set: [{ documentId: "doc-s1" }] } }]);

    const error = await refusal(
      applyWriteRule({ title: "T", space: "s1", slug: "x" }, derived, env),
    );
    expect(error.details).toEqual({ keys: ["slug"] });
  });

  it("fails the request (not a 400) when the policy did not supply a check", async () => {
    const error = await applyWriteRule({ space: "s1" }, RULE, { callerId: CALLER }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(errors.ValidationError);
  });
});

describe("enforceWriteAllowlist", () => {
  const TEAM = { uid: TEAM_UID, action: "update" as const };

  it("resolves false for a class without a rule and leaves the body alone", async () => {
    const body = { data: { members: [1] } };
    await expect(
      enforceWriteAllowlist(
        { request: { body } },
        { ...TEAM, roleClass: "member" },
        { callerId: 1 },
      ),
    ).resolves.toBe(false);
    expect(body).toEqual({ data: { members: [1] } });
  });

  it("replaces request.body.data with the checked payload and keeps other body keys", async () => {
    const body: Record<string, unknown> = { data: { description: "New" }, meta: 1 };
    await expect(
      enforceWriteAllowlist(
        { request: { body } },
        { ...TEAM, roleClass: "teamLead" },
        { callerId: 1 },
      ),
    ).resolves.toBe(true);
    expect(body).toEqual({ data: { description: "New" }, meta: 1 });
  });

  it("answers 400 for a missing body, like the core", async () => {
    const error = await refusal(
      enforceWriteAllowlist({ request: {} }, { ...TEAM, roleClass: "teamLead" }, { callerId: 1 }),
    );
    expect(error.message).toBe(MISSING_DATA_MESSAGE);
  });

  it("pins the write to status=published on the request query the controller reads", async () => {
    // ?status=draft&populate[...] would answer with draft rows (FX07 review).
    const query: Record<string, unknown> = {
      status: "draft",
      publicationState: "preview",
      populate: { teams: { fields: ["description"] } },
    };
    const request = { body: { data: { description: "x" } }, query };
    await expect(
      enforceWriteAllowlist({ request }, { ...TEAM, roleClass: "teamLead" }, { callerId: 1 }),
    ).resolves.toBe(true);
    expect(request.query).toBe(query);
    expect(query).toEqual({
      status: "published",
      populate: { teams: { fields: ["description"] } },
    });
  });

  it("pins the status before looking at the payload, and even without a client query", async () => {
    const refused = { body: { data: { members: [1] } }, query: { status: "draft" } };
    await refusal(
      enforceWriteAllowlist(
        { request: refused },
        { ...TEAM, roleClass: "teamLead" },
        { callerId: 1 },
      ),
    );
    expect(refused.query).toEqual({ status: "published" });

    const bare: { body: unknown; query?: Record<string, unknown> } = {
      body: { data: { description: "x" } },
    };
    await enforceWriteAllowlist(
      { request: bare },
      { ...TEAM, roleClass: "teamLead" },
      { callerId: 1 },
    );
    expect(bare.query).toEqual({ status: "published" });
  });

  it("leaves the query alone for a class without a rule (the policy answers 403)", async () => {
    const request = { body: { data: {} }, query: { status: "draft" } };
    await expect(
      enforceWriteAllowlist({ request }, { ...TEAM, roleClass: "member" }, { callerId: 1 }),
    ).resolves.toBe(false);
    expect(request.query).toEqual({ status: "draft" });
  });

  it("does not resolve inherited property names as classes", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(writeRuleFor(TEAM_UID, "update", name), name).toBeUndefined();
    }
    expect(writeRuleFor("api::wiki-space.wiki-space", "update", "author")).toBeUndefined();
    expect(writeRuleFor(DEPARTMENT_UID, "create", "head")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe("WRITE_ALLOWLIST", () => {
  const table: WriteAllowlist = WRITE_ALLOWLIST;
  const fieldsOf = (uid: string, action: "create" | "update", roleClass: string) =>
    Object.keys(writeRuleFor(uid, action, roleClass)?.fields ?? {}).sort();

  it("grants exactly the documented fields per role class", () => {
    for (const [type, classes] of Object.entries(TRAINING_FIELDS)) {
      for (const [roleClass, fields] of Object.entries(classes)) {
        for (const action of ["create", "update"] as const) {
          expect(fieldsOf(`api::${type}.${type}`, action, roleClass)).toEqual([...fields].sort());
        }
      }
    }
    for (const [type, classes] of Object.entries(ORG_FIELDS)) {
      for (const [roleClass, fields] of Object.entries(classes)) {
        expect(fieldsOf(`api::${type}.${type}`, "update", roleClass)).toEqual([...fields].sort());
      }
    }
    expect(fieldsOf(DEPARTMENT_UID, "update", "departmentHead")).toEqual(["color", "description"]);
    expect(fieldsOf(TEAM_UID, "update", "teamLead")).toEqual(["description"]);
    expect(fieldsOf(TEAM_UID, "update", "departmentHead")).toEqual(["description"]);
    const content = ["body", "order", "summary", "tags", "title", "tocEnabled"];
    expect(fieldsOf(WIKI_PAGE_UID, "create", "author")).toEqual(
      [...content, "parent", "space"].sort(),
    );
    for (const roleClass of ["author", "departmentHead", "teamLead"]) {
      expect(fieldsOf(WIKI_PAGE_UID, "update", roleClass), roleClass).toEqual(
        [...content, "parent", "revisionSummary"].sort(),
      );
      expect(writeRuleFor(WIKI_PAGE_UID, "update", roleClass)?.derivedFields).toBeUndefined();
      // lastEditor is the caller of every save.
      expect(writeRuleFor(WIKI_PAGE_UID, "update", roleClass)?.callerFields).toEqual([
        "lastEditor",
      ]);
    }
    expect(writeRuleFor(WIKI_PAGE_UID, "create", "author")?.callerFields).toEqual([
      "author",
      "lastEditor",
    ]);
    expect(
      Object.keys(writeRuleFor(WIKI_PAGE_UID, "create", "author")?.derivedFields ?? {}),
    ).toEqual(["slug"]);
    // Moderators (batch 16): department, team, the schedule; space on create only.
    expect(fieldsOf(WIKI_PAGE_UID, "create", MODERATOR_CLASS)).toEqual(
      [...content, "department", "parent", "publishAt", "revisionSummary", "space", "team"].sort(),
    );
    expect(fieldsOf(WIKI_PAGE_UID, "update", MODERATOR_CLASS)).toEqual(
      [...content, "department", "parent", "publishAt", "revisionSummary", "team"].sort(),
    );
    expect(fieldsOf(WIKI_SPACE_UID, "create", MODERATOR_CLASS)).toEqual(
      ["allowedRoles", "department", "description", "icon", "name", "team", "visibility"].sort(),
    );
    expect(writeClassesFor(WIKI_SPACE_UID, "update")).toEqual([MODERATOR_CLASS]);
    expect(
      Object.keys(writeRuleFor(WIKI_SPACE_UID, "create", MODERATOR_CLASS)?.derivedFields ?? {}),
    ).toEqual(["slug"]);
    expect(writeRuleFor(WIKI_SPACE_UID, "update", MODERATOR_CLASS)?.derivedFields).toBeUndefined();
    expect(Object.keys(table).sort()).toEqual(
      [
        DEPARTMENT_UID,
        TEAM_UID,
        WIKI_PAGE_UID,
        WIKI_SPACE_UID,
        "api::announcement.announcement",
        "api::event.event",
        "api::quick-link.quick-link",
        "api::document.document",
        "api::poll.poll",
        "api::course.course",
        "api::lesson.lesson",
        "api::duty-plan.duty-plan",
        "api::kpi.kpi",
      ].sort(),
    );
  });

  it("carries exactly the @sinnlos/domain wiki field lists per class (K18)", () => {
    for (const [uid, type] of [
      [WIKI_SPACE_UID, "wikiSpace"],
      [WIKI_PAGE_UID, "wikiPage"],
    ] as const) {
      for (const action of ["create", "update"] as const) {
        const byClass = WIKI_FIELDS[type][action] as Record<string, readonly string[]>;
        expect(writeClassesFor(uid, action), `${uid} ${action}`).toEqual(
          Object.keys(byClass).sort(),
        );
        for (const [roleClass, fields] of Object.entries(byClass)) {
          expect(fieldsOf(uid, action, roleClass), `${uid} ${action} ${roleClass}`).toEqual(
            [...fields].sort(),
          );
        }
      }
    }
  });

  it("the wiki moderator create rule checks space before parent", () => {
    const fields = Object.keys(
      writeRuleFor(WIKI_PAGE_UID, "create", MODERATOR_CLASS)?.fields ?? {},
    );
    expect(fields.indexOf("space")).toBeLessThan(fields.indexOf("parent"));
  });

  it("the wiki create rule checks space before parent", () => {
    const fields = Object.keys(writeRuleFor(WIKI_PAGE_UID, "create", "author")?.fields ?? {});
    expect(fields.indexOf("space")).toBeLessThan(fields.indexOf("parent"));
  });

  for (const [uid, actions] of Object.entries(table)) {
    const attributes = schemaOf(uid);
    for (const [action, classes] of Object.entries(actions ?? {})) {
      for (const [roleClass, rule] of Object.entries(classes ?? {})) {
        describe(`${uid} ${action} ${roleClass}`, () => {
          it("value fields are scalar attributes of the schema", () => {
            for (const [name, spec] of Object.entries(rule.fields)) {
              if (spec.kind !== "value") continue;
              expect(attributes[name], name).toBeDefined();
              expect(["relation", "media", "component", "dynamiczone"], name).not.toContain(
                attributes[name].type,
              );
            }
          });

          it("relation fields are owning to-one relations (never an inverse side or media)", () => {
            for (const [name, spec] of Object.entries(rule.fields)) {
              if (spec.kind !== "relation") continue;
              expect(attributes[name]?.type, name).toBe("relation");
              expect(["manyToOne", "oneToOne"], name).toContain(attributes[name].relation);
              expect(attributes[name].mappedBy, name).toBeUndefined();
            }
          });

          it("list and role fields are owning to-many relations", () => {
            for (const [name, spec] of Object.entries(rule.fields)) {
              if (spec.kind !== "relationList" && spec.kind !== "roleTypes") continue;
              expect(attributes[name]?.type, name).toBe("relation");
              expect(["manyToMany", "oneToMany"], name).toContain(attributes[name].relation);
              expect(attributes[name].mappedBy, name).toBeUndefined();
              if (spec.kind === "roleTypes") {
                expect(attributes[name].target, name).toBe("plugin::users-permissions.role");
                expect(spec.allowed, name).not.toContain("public");
                expect(spec.allowed, name).not.toContain("authenticated");
              }
            }
          });

          it("controller fields are not schema attributes", () => {
            for (const [name, spec] of Object.entries(rule.fields)) {
              if (spec.kind === "controller") expect(attributes[name], name).toBeUndefined();
            }
          });

          it("caller fields are user relations the payload itself may not name", () => {
            for (const name of rule.callerFields ?? []) {
              expect(attributes[name]?.target, name).toBe("plugin::users-permissions.user");
              expect(Object.keys(rule.fields), name).not.toContain(name);
            }
          });

          it("derived fields are schema attributes the payload itself may not name", () => {
            for (const name of [
              ...Object.keys(rule.derivedFields ?? {}),
              ...Object.keys(rule.derivedFromMerged ?? {}),
              ...Object.keys(rule.derivedOnCreate ?? {}),
            ]) {
              expect(attributes[name], name).toBeDefined();
              expect(Object.keys(rule.fields), name).not.toContain(name);
              expect(rule.callerFields ?? [], name).not.toContain(name);
            }
          });

          it("no client-written field is unique (a clash would reveal hidden rows)", () => {
            // Strapi checks uid/unique attributes on publish against every
            // published row of the type, including rows the caller cannot
            // read. Such attributes belong in derivedFields. The one
            // exceptions: a wiki space's `name` for moderators, who read
            // every space (wiki-visibility bypasses them), and a
            // department's `name` for admin_role (every staff role reads
            // every department), so a clash reveals nothing to them.
            const unique = Object.keys(rule.fields).filter(
              (name) =>
                (attributes[name]?.type === "uid" || attributes[name]?.unique === true) &&
                !(
                  (uid === WIKI_SPACE_UID || uid === DEPARTMENT_UID) &&
                  roleClass === MODERATOR_CLASS &&
                  name === "name"
                ),
            );
            expect(unique).toEqual([]);
          });
        });
      }
    }
  }
});

describe("the engine against the real table", () => {
  it("refuses every inverse, ownership, placement and media key on every rule", async () => {
    for (const [uid, actions] of Object.entries(WRITE_ALLOWLIST as WriteAllowlist)) {
      const attributes = schemaOf(uid);
      for (const classes of Object.values(actions ?? {})) {
        for (const rule of Object.values(classes ?? {})) {
          const forbidden = Object.keys(attributes).filter((name) => {
            const attr = attributes[name];
            const inverseOrMedia = attr.type === "media" || attr.mappedBy !== undefined;
            const userLink = attr.target === "plugin::users-permissions.user";
            const placement = ["department", "team", "space"].includes(name);
            return (inverseOrMedia || userLink || placement) && !(name in rule.fields);
          });
          for (const key of forbidden) {
            const error = await refusal(
              applyWriteRule({ [key]: null }, rule, { callerId: 1, relationChecks: {} }),
            );
            // A required relation the payload leaves out is refused with it.
            const required = Object.entries(rule.fields)
              .filter(([name, spec]) => spec.kind === "relation" && spec.required && name !== key)
              .map(([name]) => name);
            expect(error.details, `${uid} ${key}`).toEqual({ keys: [key, ...required].sort() });
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// v2 authoring (deep-dive decision 06 §B1, §N6; batch 15 lane 15A)
// ---------------------------------------------------------------------------

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const QUICK_LINK = "api::quick-link.quick-link";
const DOCUMENT = "api::document.document";
const POLL = "api::poll.poll";
/** The authored types the attribute-coverage pin walks (the wiki since batch 16). */
const DUTY_PLAN = "api::duty-plan.duty-plan";
const KPI = "api::kpi.kpi";
const V2_UIDS = [
  ANNOUNCEMENT,
  EVENT,
  QUICK_LINK,
  DOCUMENT,
  POLL,
  WIKI_SPACE_UID,
  WIKI_PAGE_UID,
  DUTY_PLAN,
  KPI,
];

const ENG_DOC = "deng00000000000000000000";
const SALES_DOC = "dsal00000000000000000000";
const ENG = { id: 10, documentId: ENG_DOC };
const NOW = Date.parse("2026-10-13T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const docOf = (ref: RelationRef) => ("id" in ref ? `doc-${ref.id}` : ref.documentId);

/**
 * Checks that resolve every ref to `doc-<id>` or the documentId, except the
 * ones the test names as unknown; the caller-department checks accept only
 * Engineering, like utils/authoring-checks.ts (its own suite pins the real
 * ones against the stub database).
 */
function v2Env(
  overrides: Partial<WriteRuleEnvironment> = {},
  unknown: readonly string[] = ["doc-404"],
): WriteRuleEnvironment {
  const resolve: RelationCheck = async (input) => {
    const target = input.target ? docOf(input.target) : (input.target as null | undefined);
    if (typeof target === "string" && unknown.includes(target)) return null;
    return { target, disconnect: input.disconnect.map(docOf) };
  };
  const resolveList: RelationListCheck = async (refs) => {
    const ids = [...new Set(refs.map(docOf))];
    return ids.some((id) => unknown.includes(id)) ? null : ids;
  };
  return {
    callerId: 42,
    relationChecks: {
      department: resolve,
      team: resolve,
      callerDepartment: async (input) =>
        input.target && docOf(input.target) === ENG_DOC && input.disconnect.length === 0
          ? { target: ENG_DOC, disconnect: [] }
          : null,
      teamOfCallerDepartment: async (input) =>
        input.target === null
          ? { target: null, disconnect: [] }
          : input.target && docOf(input.target) === "team-eng"
            ? { target: "team-eng", disconnect: [] }
            : null,
    },
    relationListChecks: {
      departments: resolveList,
      callerDepartments: async (refs) =>
        refs.length === 1 && docOf(refs[0]) === ENG_DOC ? [ENG_DOC] : null,
    },
    roleTypesCheck: async (types) => types.map((type) => `role-${type}`),
    frozenChecks: { pollHasVotes: async () => false },
    readiness: async () => [],
    callerDepartment: ENG,
    now: NOW,
    ...overrides,
  };
}

const fieldsOf = (uid: string, action: "create" | "update", roleClass: string) =>
  Object.keys(writeRuleFor(uid, action, roleClass)?.fields ?? {}).sort();

const rule = (uid: string, action: "create" | "update", roleClass: string): WriteRule => {
  const found = writeRuleFor(uid, action, roleClass);
  if (!found) throw new Error(`no rule ${uid} ${action} ${roleClass}`);
  return found;
};

describe("v2 rules: attribute coverage and field lists (§B1.7, §N6)", () => {
  it("covers every schema attribute: a field of some class, or refused with a reason", () => {
    for (const uid of V2_UIDS) {
      const attributes = Object.keys(schemaOf(uid));
      const listed = new Set(
        (["create", "update"] as const).flatMap((action) =>
          writeClassesFor(uid, action).flatMap((roleClass) =>
            Object.keys(rule(uid, action, roleClass).fields),
          ),
        ),
      );
      const refused = REFUSED_ATTRIBUTES[uid] ?? {};
      for (const attribute of attributes) {
        const inRule = listed.has(attribute);
        const isRefused = Object.prototype.hasOwnProperty.call(refused, attribute);
        expect(inRule !== isRefused, `${uid}.${attribute}: exactly one of rule or refused`).toBe(
          true,
        );
        if (isRefused)
          expect(refused[attribute].length, `${uid}.${attribute} reason`).toBeGreaterThan(10);
      }
      for (const attribute of Object.keys(refused)) {
        expect(attributes, `${uid}.${attribute} is a schema attribute`).toContain(attribute);
      }
    }
  });

  it("refuses the derived and bookkeeping attributes the decision names, for every class", () => {
    expect(Object.keys(REFUSED_ATTRIBUTES[ANNOUNCEMENT]).sort()).toEqual(
      ["audience", "author", "ownerDepartment", "retargetRequired", "scheduleError"].sort(),
    );
    expect(Object.keys(REFUSED_ATTRIBUTES[EVENT]).sort()).toEqual(
      ["notifyAudience", "organizer", "ownerDepartment", "scheduleError"].sort(),
    );
    expect(Object.keys(REFUSED_ATTRIBUTES[QUICK_LINK]).sort()).toEqual(
      ["audience", "scheduleError"].sort(),
    );
    expect(Object.keys(REFUSED_ATTRIBUTES[DOCUMENT]).sort()).toEqual(
      ["audience", "ownerDepartment", "scheduleError", "uploadedBy"].sort(),
    );
    expect(Object.keys(REFUSED_ATTRIBUTES[POLL]).sort()).toEqual(["audience", "author"].sort());
  });

  it("carries exactly the @sinnlos/domain field lists per class, on create and update", () => {
    const lists: Record<string, Record<string, readonly string[]>> = {
      [ANNOUNCEMENT]: {
        moderator: ANNOUNCEMENT_MODERATOR_FIELDS,
        departmentAuthor: ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS,
      },
      [EVENT]: {
        moderator: EVENT_MODERATOR_FIELDS,
        departmentAuthor: EVENT_DEPARTMENT_AUTHOR_FIELDS,
      },
      [QUICK_LINK]: { moderator: QUICK_LINK_MODERATOR_FIELDS },
      [DOCUMENT]: {
        moderator: DOCUMENT_MODERATOR_FIELDS,
        departmentAuthor: DOCUMENT_DEPARTMENT_AUTHOR_FIELDS,
      },
      [POLL]: { moderator: POLL_MODERATOR_FIELDS },
    };
    for (const [uid, byClass] of Object.entries(lists)) {
      for (const action of ["create", "update"] as const) {
        expect(writeClassesFor(uid, action), `${uid} ${action}`).toEqual(
          Object.keys(byClass).sort(),
        );
        for (const [roleClass, fields] of Object.entries(byClass)) {
          expect(fieldsOf(uid, action, roleClass), `${uid} ${action} ${roleClass}`).toEqual(
            [...fields].sort(),
          );
        }
      }
    }
  });

  // The exact department-author lists (§N6), written out: a field added to
  // a moderator rule never reaches department authors unreviewed.
  it("pins each departmentAuthor rule's fields exactly", () => {
    expect(fieldsOf(ANNOUNCEMENT, "update", DEPARTMENT_AUTHOR_CLASS)).toEqual(
      ["audienceRoles", "body", "department", "expiresAt", "team", "title"].sort(),
    );
    expect(fieldsOf(EVENT, "update", DEPARTMENT_AUTHOR_CLASS)).toEqual(
      [
        "allDay",
        "capacity",
        "departments",
        "description",
        "end",
        "location",
        "rsvpEnabled",
        "start",
        "title",
        "url",
      ].sort(),
    );
    expect(fieldsOf(DOCUMENT, "update", DEPARTMENT_AUTHOR_CLASS)).toEqual(
      ["category", "departments", "description", "file", "title"].sort(),
    );
    for (const uid of [ANNOUNCEMENT, EVENT, DOCUMENT]) {
      expect(fieldsOf(uid, "create", DEPARTMENT_AUTHOR_CLASS)).toEqual(
        fieldsOf(uid, "update", DEPARTMENT_AUTHOR_CLASS),
      );
    }
    expect(writeRuleFor(QUICK_LINK, "create", DEPARTMENT_AUTHOR_CLASS)).toBeUndefined();
    expect(writeRuleFor(POLL, "update", DEPARTMENT_AUTHOR_CLASS)).toBeUndefined();
  });

  it("sets the caller on create only, and the owner only for department authors' creates", () => {
    const owners = (uid: string, action: "create" | "update", roleClass: string) =>
      Object.keys(rule(uid, action, roleClass).derivedOnCreate ?? {});
    expect(rule(ANNOUNCEMENT, "create", MODERATOR_CLASS).callerFields).toEqual(["author"]);
    expect(rule(EVENT, "create", DEPARTMENT_AUTHOR_CLASS).callerFields).toEqual(["organizer"]);
    expect(rule(DOCUMENT, "create", MODERATOR_CLASS).callerFields).toEqual(["uploadedBy"]);
    expect(rule(POLL, "create", MODERATOR_CLASS).callerFields).toEqual(["author"]);
    expect(rule(QUICK_LINK, "create", MODERATOR_CLASS).callerFields).toBeUndefined();
    for (const uid of [ANNOUNCEMENT, EVENT, DOCUMENT]) {
      expect(rule(uid, "update", MODERATOR_CLASS).callerFields, uid).toBeUndefined();
      expect(owners(uid, "create", DEPARTMENT_AUTHOR_CLASS), uid).toEqual(["ownerDepartment"]);
      expect(owners(uid, "update", DEPARTMENT_AUTHOR_CLASS), uid).toEqual([]);
      expect(owners(uid, "create", MODERATOR_CLASS), uid).toEqual([]);
    }
  });
});

describe("v2 value checks and codes", () => {
  const moderatorAnnouncement = rule(ANNOUNCEMENT, "update", MODERATOR_CLASS);

  it("answers the code of each refused value, and none for a refused key", async () => {
    const error = await refusal(
      applyWriteRule(
        {
          title: "x".repeat(256),
          body: 42,
          expiresAt: "2026-10-20T09:00:00",
          ackDeadline: "2026-13-01",
          author: 7,
          populate: "*",
        },
        moderatorAnnouncement,
        v2Env(),
      ),
    );
    expect(error.details).toEqual({
      keys: ["ackDeadline", "author", "body", "expiresAt", "populate", "title"],
      codes: {
        ackDeadline: "invalidDate",
        body: "invalid",
        expiresAt: "invalidInstant",
        title: "tooLong",
      },
    });
  });

  it("refuses a blank title as required and answers only keys without any coded refusal", async () => {
    const blank = await refusal(applyWriteRule({ title: "  " }, moderatorAnnouncement, v2Env()));
    expect(blank.details).toEqual({ keys: ["title"], codes: { title: "required" } });
    const keysOnly = await refusal(
      applyWriteRule({ pinned: true, audience: "all" }, moderatorAnnouncement, v2Env()),
    );
    expect(keysOnly.details).toEqual({ keys: ["audience"] });
  });

  it("quick links: an http(s) URL or an internal path, an icon key, a category, an order", async () => {
    const links = rule(QUICK_LINK, "create", MODERATOR_CLASS);
    const ok = await applyWriteRule(
      { label: "Payroll", url: "/wiki/hr", icon: "Wallet", category: "hr", order: 3 },
      links,
      v2Env(),
    );
    expect(ok).toMatchObject({ label: "Payroll", url: "/wiki/hr", icon: "Wallet" });
    const error = await refusal(
      applyWriteRule(
        { label: "x", url: "//evil.example", icon: "wallet", category: "misc", order: 10001 },
        links,
        v2Env(),
      ),
    );
    expect(error.details).toEqual({
      keys: ["category", "icon", "order", "url"],
      codes: { category: "invalid", icon: "invalid", order: "invalid", url: "invalidUrl" },
    });
  });

  it("polls: 2-20 options of at most 200 characters, unique after trimming (plan item 2b)", async () => {
    const polls = rule(POLL, "create", MODERATOR_CLASS);
    const options = (count: number) => Array.from({ length: count }, (_, i) => `A${i}`);
    for (const count of [2, 10, 11, 20]) {
      const out = await applyWriteRule({ question: "Q?", options: options(count) }, polls, v2Env());
      expect(out.options, String(count)).toEqual(options(count));
    }
    const cases: Array<[unknown, string]> = [
      [options(21), "optionCount"],
      [["Only"], "optionCount"],
      [["x".repeat(201), "B"], "tooLong"],
      [["A", " A "], "optionDuplicate"],
      [["A", ""], "required"],
      ["A,B", "invalid"],
    ];
    for (const [value, code] of cases) {
      const error = await refusal(applyWriteRule({ options: value }, polls, v2Env()));
      expect(error.details, JSON.stringify(value)).toEqual({
        keys: ["options"],
        codes: { options: code },
      });
    }
  });
});

describe("v2 relations, lists and role types", () => {
  const moderatorAnnouncement = rule(ANNOUNCEMENT, "update", MODERATOR_CLASS);
  const moderatorEvent = rule(EVENT, "update", MODERATOR_CLASS);

  it("rewrites to-one and to-many relations to documentIds; null and [] clear", async () => {
    const out = await applyWriteRule(
      { department: { documentId: SALES_DOC }, team: null },
      moderatorAnnouncement,
      v2Env(),
    );
    expect(out).toMatchObject({
      department: { set: [{ documentId: SALES_DOC }] },
      team: null,
    });
    const list = await applyWriteRule({ departments: [3, SALES_DOC, 3] }, moderatorEvent, v2Env());
    expect(list.departments).toEqual({
      set: [{ documentId: "doc-3" }, { documentId: SALES_DOC }],
    });
    for (const clear of [null, [], { set: [] }]) {
      const cleared = await applyWriteRule({ departments: clear }, moderatorEvent, v2Env());
      expect(cleared.departments, JSON.stringify(clear)).toEqual({ set: [] });
    }
  });

  it("refuses list shapes other than a full replacement, and more than the maximum", async () => {
    for (const value of [
      { connect: [3] },
      { set: [3], connect: [4] },
      [[3]],
      [{ id: 3, locale: "de" }],
      Array.from({ length: 51 }, (_, i) => i + 1),
      "3",
    ]) {
      const error = await refusal(applyWriteRule({ departments: value }, moderatorEvent, v2Env()));
      expect(error.details, JSON.stringify(value)).toEqual({ keys: ["departments"] });
    }
  });

  it("answers a relation the check refuses like a malformed one: its key, no code (no oracle)", async () => {
    for (const data of [{ department: "doc-404" }, { department: { bogus: 1 } }]) {
      const error = await refusal(applyWriteRule(data, moderatorAnnouncement, v2Env()));
      expect(error.details, JSON.stringify(data)).toEqual({ keys: ["department"] });
    }
    const list = await refusal(
      applyWriteRule({ departments: ["doc-404"] }, moderatorEvent, v2Env()),
    );
    expect(list.details).toEqual({ keys: ["departments"] });
  });

  it("writes audience roles as role types, resolved on the server", async () => {
    const roleTypesCheck = vi.fn(async (types: string[]) => types.map((type) => `role-${type}`));
    const out = await applyWriteRule(
      { audienceRoles: ["member", "team_lead", "member"] },
      moderatorAnnouncement,
      v2Env({ roleTypesCheck }),
    );
    expect(out.audienceRoles).toEqual({
      set: [{ documentId: "role-member" }, { documentId: "role-team_lead" }],
    });
    expect(roleTypesCheck).toHaveBeenCalledWith(["member", "team_lead"]);
    const cleared = await applyWriteRule(
      { audienceRoles: null },
      moderatorAnnouncement,
      v2Env({ roleTypesCheck }),
    );
    expect(cleared.audienceRoles).toEqual({ set: [] });
    // A moderator may name the guest role; department authors only staff role types.
    await applyWriteRule({ audienceRoles: ["guest"] }, moderatorAnnouncement, v2Env());
    const head = rule(ANNOUNCEMENT, "update", DEPARTMENT_AUTHOR_CLASS);
    for (const value of [["guest"], ["public"], ["authenticated"], ["Member"], [3], "member"]) {
      const error = await refusal(applyWriteRule({ audienceRoles: value }, head, v2Env()));
      expect(error.details, JSON.stringify(value)).toEqual({ keys: ["audienceRoles"] });
    }
    for (const value of [["public"], ["authenticated"], [{ id: 2 }]]) {
      const error = await refusal(
        applyWriteRule({ audienceRoles: value }, moderatorAnnouncement, v2Env()),
      );
      expect(error.details, JSON.stringify(value)).toEqual({ keys: ["audienceRoles"] });
    }
    // A check that cannot resolve a type refuses the field.
    const unresolved = await refusal(
      applyWriteRule(
        { audienceRoles: ["member"] },
        moderatorAnnouncement,
        v2Env({ roleTypesCheck: async () => null }),
      ),
    );
    expect(unresolved.details).toEqual({ keys: ["audienceRoles"] });
  });
});

describe("v2 department authors: pinned targeting and ownership (§N3, §N4)", () => {
  it("pins an announcement's department: set on create when missing, D only, never null", async () => {
    const create = rule(ANNOUNCEMENT, "create", DEPARTMENT_AUTHOR_CLASS);
    const out = await applyWriteRule({ title: "Hi" }, create, { ...v2Env(), action: "create" });
    expect(out).toMatchObject({
      department: { set: [{ documentId: ENG_DOC }] },
      audience: "departments",
      retargetRequired: false,
      ownerDepartment: { set: [{ documentId: ENG_DOC }] },
      author: 42,
    });
    await applyWriteRule({ title: "Hi", department: ENG_DOC }, create, {
      ...v2Env(),
      action: "create",
    });
    const update = rule(ANNOUNCEMENT, "update", DEPARTMENT_AUTHOR_CLASS);
    for (const department of [SALES_DOC, null, { connect: [ENG_DOC], disconnect: [SALES_DOC] }]) {
      const error = await refusal(applyWriteRule({ department }, update, v2Env()));
      expect(error.details, JSON.stringify(department)).toEqual({ keys: ["department"] });
    }
    // An update without the key leaves the stored department (no default).
    const titleOnly = await applyWriteRule({ title: "x" }, update, {
      ...v2Env(),
      action: "update",
    });
    expect(titleOnly).toEqual({ title: "x" });
  });

  it("accepts null or a team of the caller's department, nothing else", async () => {
    const update = rule(ANNOUNCEMENT, "update", DEPARTMENT_AUTHOR_CLASS);
    expect((await applyWriteRule({ team: "team-eng" }, update, v2Env())).team).toEqual({
      set: [{ documentId: "team-eng" }],
    });
    expect((await applyWriteRule({ team: null }, update, v2Env())).team).toBeNull();
    const error = await refusal(applyWriteRule({ team: "team-sales" }, update, v2Env()));
    expect(error.details).toEqual({ keys: ["team"] });
  });

  it("pins event and document departments to exactly [D]: set on create, [] and two refused", async () => {
    for (const uid of [EVENT, DOCUMENT]) {
      const create = rule(uid, "create", DEPARTMENT_AUTHOR_CLASS);
      const data = uid === EVENT ? { title: "E", start: at(60) } : { title: "D" };
      const out = await applyWriteRule(data, create, { ...v2Env(), action: "create" });
      expect(out.departments, uid).toEqual({ set: [{ documentId: ENG_DOC }] });
      expect(out.ownerDepartment, uid).toEqual({ set: [{ documentId: ENG_DOC }] });
      const update = rule(uid, "update", DEPARTMENT_AUTHOR_CLASS);
      for (const departments of [[], null, [ENG_DOC, SALES_DOC], [SALES_DOC]]) {
        const error = await refusal(applyWriteRule({ departments }, update, v2Env()));
        expect(error.details, `${uid} ${JSON.stringify(departments)}`).toEqual({
          keys: ["departments"],
        });
      }
    }
  });

  it("refuses the moderator-only keys and the owner as plain keys", async () => {
    const update = rule(ANNOUNCEMENT, "update", DEPARTMENT_AUTHOR_CLASS);
    const error = await refusal(
      applyWriteRule(
        {
          pinned: true,
          requiresAck: true,
          ackDeadline: "2026-10-30",
          publishAt: at(60),
          ownerDepartment: ENG_DOC,
        },
        update,
        v2Env(),
      ),
    );
    expect(error.details).toEqual({
      keys: ["ackDeadline", "ownerDepartment", "pinned", "publishAt", "requiresAck"],
    });
    for (const uid of [EVENT, DOCUMENT]) {
      for (const key of ["publishAt", "unpublishAt", "ownerDepartment", "scheduleError"]) {
        const refused = await refusal(
          applyWriteRule({ [key]: null }, rule(uid, "update", DEPARTMENT_AUTHOR_CLASS), v2Env()),
        );
        expect(refused.details, `${uid} ${key}`).toEqual({ keys: [key] });
      }
    }
    // ownerDepartment is refused for moderators too (derived ownership).
    for (const uid of [ANNOUNCEMENT, EVENT, DOCUMENT]) {
      const refused = await refusal(
        applyWriteRule({ ownerDepartment: ENG_DOC }, rule(uid, "update", MODERATOR_CLASS), v2Env()),
      );
      expect(refused.details, uid).toEqual({ keys: ["ownerDepartment"] });
    }
  });

  it("fails closed (500, not a write) when a department author's create comes without the department", async () => {
    const create = rule(EVENT, "create", DEPARTMENT_AUTHOR_CLASS);
    await expect(
      applyWriteRule({ title: "E", start: at(60) }, create, {
        ...v2Env({ callerDepartment: null }),
        action: "create",
      }),
    ).rejects.toThrow(/caller department/);
  });
});

describe("v2 targeting flags: derived from stored + payload, never widened implicitly (K10)", () => {
  const announcement = rule(ANNOUNCEMENT, "update", MODERATOR_CLASS);

  it("re-derives the announcement audience only when department or team is carried", async () => {
    const stored = {
      department: ENG_DOC,
      team: "team-x",
      audience: "departments",
      retargetRequired: true,
    };
    expect(await applyWriteRule({ title: "x" }, announcement, v2Env({ existing: stored }))).toEqual(
      {
        title: "x",
      },
    );
    expect(
      await applyWriteRule({ department: null }, announcement, v2Env({ existing: stored })),
    ).toMatchObject({ department: null, audience: "departments", retargetRequired: false });
    expect(
      await applyWriteRule(
        { department: null, team: null },
        announcement,
        v2Env({ existing: stored }),
      ),
    ).toMatchObject({ audience: "all", retargetRequired: false });
    expect(
      await applyWriteRule(
        { team: SALES_DOC },
        announcement,
        v2Env({ existing: { department: null, team: null } }),
      ),
    ).toMatchObject({ audience: "departments" });
  });

  it("a relation shape that names no target is no re-target: nothing is derived (K10)", async () => {
    const noOp: RelationCheck = async () => ({ target: undefined, disconnect: [] });
    const env = v2Env({
      relationChecks: { department: noOp, team: noOp },
      existing: {
        department: null,
        team: "team-x",
        audience: "departments",
        retargetRequired: true,
      },
    });
    expect(await applyWriteRule({ department: { connect: [] } }, announcement, env)).toEqual({});
    expect(await applyWriteRule({ team: { disconnect: [] } }, announcement, env)).toEqual({});
  });

  it("lowers the retargetRequired marker on audienceRoles too, without touching audience", async () => {
    const out = await applyWriteRule(
      { audienceRoles: ["member"] },
      announcement,
      v2Env({
        existing: { department: null, team: null, audience: "departments", retargetRequired: true },
      }),
    );
    expect(out).toEqual({
      audienceRoles: { set: [{ documentId: "role-member" }] },
      retargetRequired: false,
    });
  });

  it("derives event notifyAudience and the other types' audience from departments only", async () => {
    const event = rule(EVENT, "update", MODERATOR_CLASS);
    expect((await applyWriteRule({ departments: [] }, event, v2Env())).notifyAudience).toBe("all");
    expect((await applyWriteRule({ departments: [ENG_DOC] }, event, v2Env())).notifyAudience).toBe(
      "departments",
    );
    expect(await applyWriteRule({ title: "x" }, event, v2Env())).toEqual({ title: "x" });
    for (const uid of [QUICK_LINK, DOCUMENT, POLL]) {
      const update = rule(uid, "update", MODERATOR_CLASS);
      expect(
        (await applyWriteRule({ departments: [ENG_DOC] }, update, v2Env())).audience,
        uid,
      ).toBe("departments");
      expect((await applyWriteRule({ departments: null }, update, v2Env())).audience, uid).toBe(
        "all",
      );
      expect(await applyWriteRule({}, update, v2Env()), uid).toEqual({});
    }
  });
});

describe("v2 cross checks over the stored draft and the payload", () => {
  const event = rule(EVENT, "update", MODERATOR_CLASS);
  const announcement = rule(ANNOUNCEMENT, "update", MODERATOR_CLASS);

  it("refuses an end before the stored start, only when start or end is carried", async () => {
    const existing = { start: at(120), end: null, allDay: false };
    const error = await refusal(applyWriteRule({ end: at(60) }, event, v2Env({ existing })));
    expect(error.details).toEqual({ keys: ["end"], codes: { end: "endBeforeStart" } });
    // A legacy row with a bad span still saves other fields.
    const legacy = { start: at(120), end: at(60), allDay: false };
    await applyWriteRule({ title: "x" }, event, v2Env({ existing: legacy }));
  });

  it("holds all-day events to local midnights of APP_TIME_ZONE", async () => {
    // 2026-10-14 00:00 Europe/Berlin (CEST) = 2026-10-13T22:00:00Z.
    const midnight = "2026-10-13T22:00:00.000Z";
    await applyWriteRule({ allDay: true, start: midnight, end: midnight }, event, v2Env());
    const error = await refusal(
      applyWriteRule({ allDay: true, start: "2026-10-14T08:00:00.000Z" }, event, v2Env()),
    );
    expect(error.details).toEqual({ keys: ["start"], codes: { start: "notMidnight" } });
  });

  it("checks the schedule order (§D rule 3)", async () => {
    const past = await refusal(applyWriteRule({ publishAt: at(0.5) }, announcement, v2Env()));
    expect(past.details).toEqual({ keys: ["publishAt"], codes: { publishAt: "scheduleInPast" } });
    const expires = await refusal(
      applyWriteRule(
        { publishAt: at(60) },
        announcement,
        v2Env({ existing: { expiresAt: at(30) } }),
      ),
    );
    expect(expires.details).toEqual({
      keys: ["expiresAt"],
      codes: { expiresAt: "expiresBeforePublish" },
    });
    const link = rule(QUICK_LINK, "update", MODERATOR_CLASS);
    const unpublish = await refusal(
      applyWriteRule({ publishAt: at(60), unpublishAt: at(60) }, link, v2Env()),
    );
    expect(unpublish.details).toEqual({
      keys: ["unpublishAt"],
      codes: { unpublishAt: "unpublishBeforePublish" },
    });
    // A stored schedule that fell due is the scheduler's business, not this save's.
    await applyWriteRule({ title: "x" }, announcement, v2Env({ existing: { publishAt: at(-5) } }));
  });

  it("needs requiresAck for an acknowledgement deadline", async () => {
    const error = await refusal(
      applyWriteRule(
        { ackDeadline: "2026-10-30" },
        announcement,
        v2Env({ existing: { requiresAck: false } }),
      ),
    );
    expect(error.details).toEqual({
      keys: ["ackDeadline"],
      codes: { ackDeadline: "ackDeadlineWithoutAck" },
    });
    await applyWriteRule({ ackDeadline: "2026-10-30", requiresAck: true }, announcement, v2Env());
  });

  it("refuses requiresAck: true while read-confirmations is off, and still takes false (v0.28)", async () => {
    process.env.FEATURES_OFF = "read-confirmations";
    try {
      for (const uid of [ANNOUNCEMENT, DOCUMENT]) {
        const error = await refusal(
          applyWriteRule({ requiresAck: true }, rule(uid, "update", MODERATOR_CLASS), v2Env()),
        );
        expect(error.details).toEqual({ keys: ["requiresAck"], codes: { requiresAck: "invalid" } });
        await applyWriteRule({ requiresAck: false }, rule(uid, "update", MODERATOR_CLASS), v2Env());
      }
    } finally {
      delete process.env.FEATURES_OFF;
    }
  });

  it("asks publish readiness early only when the payload schedules a publish", async () => {
    const readiness = vi.fn(async () => ["title"]);
    const error = await refusal(
      applyWriteRule(
        { publishAt: at(60) },
        announcement,
        v2Env({ readiness, existing: { title: null } }),
      ),
    );
    expect(error.details).toEqual({ keys: ["title"], codes: { title: "notPublishable" } });
    expect(readiness).toHaveBeenCalledWith(
      expect.objectContaining({ publishAt: at(60), title: null }),
    );
    readiness.mockClear();
    await applyWriteRule({ publishAt: null }, announcement, v2Env({ readiness }));
    await applyWriteRule({ title: "x" }, announcement, v2Env({ readiness }));
    expect(readiness).not.toHaveBeenCalled();
  });
});

describe("v2 frozenWhen: poll options and anonymity after the first vote", () => {
  const poll = rule(POLL, "update", MODERATOR_CLASS);
  const published = { options: ["A", "B"], anonymous: false };

  it("refuses a change against the published row once a vote exists", async () => {
    const pollHasVotes = vi.fn(async () => true);
    const error = await refusal(
      applyWriteRule(
        { options: ["A", "C"], anonymous: true },
        poll,
        v2Env({ published, frozenChecks: { pollHasVotes } }),
      ),
    );
    expect(error.details).toEqual({
      keys: ["anonymous", "options"],
      codes: { anonymous: "frozenAfterVotes", options: "frozenAfterVotes" },
    });
    expect(pollHasVotes).toHaveBeenCalledTimes(1);
  });

  it("passes the same options (after trimming) without asking, and any change without a vote", async () => {
    const pollHasVotes = vi.fn(async () => true);
    await applyWriteRule(
      { options: [" A", "B "], anonymous: false, closesAt: at(60) },
      poll,
      v2Env({ published, frozenChecks: { pollHasVotes } }),
    );
    expect(pollHasVotes).not.toHaveBeenCalled();
    await applyWriteRule(
      { options: ["A", "C"] },
      poll,
      v2Env({ published, frozenChecks: { pollHasVotes: async () => false } }),
    );
    // No published row: nothing to compare against (no vote can exist).
    await applyWriteRule({ options: ["X", "Y"] }, poll, v2Env({ published: null }));
  });
});

describe("v2 media: retain versus attach (§E2)", () => {
  const MEDIA_RULE: WriteRule = { fields: { file: { kind: "media", check: "ownUpload" } } };

  it("keeps the stored file without a check, checks a new one, clears with null", async () => {
    const ownUpload = vi.fn(async (fileId: number) => (fileId === 8 ? 8 : null));
    const env = (existing: Record<string, unknown> | null) =>
      v2Env({ existing, mediaChecks: { ownUpload } });
    expect(await applyWriteRule({ file: 5 }, MEDIA_RULE, env({ file: { id: 5 } }))).toEqual({
      file: 5,
    });
    expect(ownUpload).not.toHaveBeenCalled();
    expect(await applyWriteRule({ file: { id: 8 } }, MEDIA_RULE, env({ file: { id: 5 } }))).toEqual(
      {
        file: 8,
      },
    );
    const error = await refusal(applyWriteRule({ file: 9 }, MEDIA_RULE, env(null)));
    expect(error.details).toEqual({ keys: ["file"] });
    expect(await applyWriteRule({ file: null }, MEDIA_RULE, env({ file: { id: 5 } }))).toEqual({
      file: null,
    });
    const malformed = await refusal(applyWriteRule({ file: "abc" }, MEDIA_RULE, env(null)));
    expect(malformed.details).toEqual({ keys: ["file"] });
  });
});

describe("enforceWriteAllowlist for global::can-author", () => {
  it("leaves the status to the authoring controller (no pin) and checks the payload", async () => {
    const policyContext = {
      request: { query: { status: "draft" }, body: { data: { title: "Hi" } } },
    };
    await expect(
      enforceWriteAllowlist(
        policyContext,
        { uid: ANNOUNCEMENT, action: "update", roleClass: MODERATOR_CLASS },
        v2Env(),
        { status: "controller" },
      ),
    ).resolves.toBe(true);
    expect(policyContext.request.query).toEqual({ status: "draft" });
    expect(policyContext.request.body.data).toEqual({ title: "Hi" });
  });

  it("answers false for a class without a rule (department authors on quick links and polls)", async () => {
    for (const uid of [QUICK_LINK, POLL]) {
      const policyContext = { request: { query: {}, body: { data: { label: "x" } } } };
      await expect(
        enforceWriteAllowlist(
          policyContext,
          { uid, action: "create", roleClass: DEPARTMENT_AUTHOR_CLASS },
          v2Env(),
          {
            status: "controller",
          },
        ),
        uid,
      ).resolves.toBe(false);
    }
  });
});
