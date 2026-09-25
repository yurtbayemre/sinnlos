import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_UID,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MISSING_DATA_MESSAGE,
  TEAM_UID,
  WIKI_PAGE_UID,
  WRITE_ALLOWLIST,
  applyWriteRule,
  enforceWriteAllowlist,
  isWriteBypassRole,
  parseToOneRelation,
  valueChecks,
  writeAllowlistMessage,
  writeRuleFor,
  type RelationCheck,
  type RelationRef,
  type ResolvedToOne,
  type ToOneRelationInput,
  type WriteAllowlist,
  type WriteRule,
} from "./write-allowlist";

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

  it("uid uses Strapi's uid character set", () => {
    expect(valueChecks.uid("onboarding-2026_v1.0~a")).toBe(true);
    expect(valueChecks.uid("with space")).toBe(false);
    expect(valueChecks.uid("slash/es")).toBe(false);
    expect(valueChecks.uid("")).toBe(false);
    expect(valueChecks.uid("a".repeat(256))).toBe(false);
    expect(valueChecks.uid(null)).toBe(false);
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
      enforceWriteAllowlist({ request: { body } }, { ...TEAM, roleClass: "lead" }, { callerId: 1 }),
    ).resolves.toBe(true);
    expect(body).toEqual({ data: { description: "New" }, meta: 1 });
  });

  it("answers 400 for a missing body, like the core", async () => {
    const error = await refusal(
      enforceWriteAllowlist({ request: {} }, { ...TEAM, roleClass: "lead" }, { callerId: 1 }),
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
      enforceWriteAllowlist({ request }, { ...TEAM, roleClass: "lead" }, { callerId: 1 }),
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
      enforceWriteAllowlist({ request: refused }, { ...TEAM, roleClass: "lead" }, { callerId: 1 }),
    );
    expect(refused.query).toEqual({ status: "published" });

    const bare: { body: unknown; query?: Record<string, unknown> } = {
      body: { data: { description: "x" } },
    };
    await enforceWriteAllowlist({ request: bare }, { ...TEAM, roleClass: "lead" }, { callerId: 1 });
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

  it("isWriteBypassRole covers exactly admin_role and editor", () => {
    expect(isWriteBypassRole("admin_role")).toBe(true);
    expect(isWriteBypassRole("editor")).toBe(true);
    for (const role of [
      "department_head",
      "team_lead",
      "member",
      "guest",
      "authenticated",
      undefined,
    ]) {
      expect(isWriteBypassRole(role), String(role)).toBe(false);
    }
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
    expect(fieldsOf(DEPARTMENT_UID, "update", "head")).toEqual(["color", "description"]);
    expect(fieldsOf(TEAM_UID, "update", "lead")).toEqual(["description"]);
    expect(fieldsOf(TEAM_UID, "update", "departmentHead")).toEqual(["description"]);
    const content = ["body", "order", "slug", "summary", "tags", "title", "tocEnabled"];
    expect(fieldsOf(WIKI_PAGE_UID, "create", "author")).toEqual(
      [...content, "parent", "space"].sort(),
    );
    for (const roleClass of ["author", "departmentHead", "teamLead"]) {
      expect(fieldsOf(WIKI_PAGE_UID, "update", roleClass), roleClass).toEqual(
        [...content, "parent", "revisionSummary"].sort(),
      );
    }
    expect(writeRuleFor(WIKI_PAGE_UID, "create", "author")?.callerFields).toEqual([
      "author",
      "lastEditor",
    ]);
    expect(Object.keys(table).sort()).toEqual([DEPARTMENT_UID, TEAM_UID, WIKI_PAGE_UID].sort());
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
            expect(error.details, `${uid} ${key}`).toEqual({
              keys: rule.fields.space && key !== "space" ? [key, "space"].sort() : [key],
            });
          }
        }
      }
    }
  });
});
