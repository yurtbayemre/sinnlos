import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ACCOUNT_FIELDS, CONTENT_RELATIONS, ORGANISATION_RELATIONS } from "./utils/user-export";

/**
 * The data export covers every relation to the user model (v0.28,
 * plan-v028-rev2.md §3; the raw-writers inventory pattern): a new relation
 * to a person fails here until utils/user-export.ts exports it
 * (CONTENT_RELATIONS) or `organisation` lists it (ORGANISATION_RELATIONS).
 */

const USER_UID = "plugin::users-permissions.user";
/** Credentials and second-factor state: never exported. */
const SECRETS = [
  "password",
  "resetPasswordToken",
  "confirmationToken",
  "tokenVersion",
  "totpSecret",
  "totpRecoveryCodes",
  "totpLastStep",
];
const SRC = __dirname;

interface Schema {
  info: { singularName: string };
  attributes: Record<string, { type?: string; target?: string }>;
}

/** uid → schema of every api content type and the user model. */
function schemas(): Map<string, Schema> {
  const out = new Map<string, Schema>();
  for (const api of readdirSync(join(SRC, "api"))) {
    const types = join(SRC, "api", api, "content-types");
    if (!existsSync(types)) continue;
    for (const type of readdirSync(types)) {
      const file = join(types, type, "schema.json");
      if (!existsSync(file)) continue;
      out.set(`api::${api}.${type}`, JSON.parse(readFileSync(file, "utf8")));
    }
  }
  out.set(
    USER_UID,
    JSON.parse(
      readFileSync(
        join(SRC, "extensions/users-permissions/content-types/user/schema.json"),
        "utf8",
      ),
    ),
  );
  return out;
}

describe("the data export (Art. 15) covers every relation to a person", () => {
  const relations = [...schemas()].flatMap(([uid, schema]) =>
    Object.entries(schema.attributes)
      .filter(([, attribute]) => attribute.type === "relation" && attribute.target === USER_UID)
      .map(([field]) => `${uid}.${field}`),
  );

  it("finds the relations it checks", () => {
    expect(relations.length).toBeGreaterThan(20);
  });

  it("exports each of them, or lists it under organisation", () => {
    const covered = new Set([
      ...CONTENT_RELATIONS.map((relation) => `${relation.uid}.${relation.field}`),
      ...ORGANISATION_RELATIONS,
    ]);
    expect(relations.filter((relation) => !covered.has(relation)).sort()).toEqual([]);
  });

  it("names no relation that does not exist (a renamed field leaves no stale entry)", () => {
    const existing = new Set(relations);
    expect(
      [
        ...CONTENT_RELATIONS.map((relation) => `${relation.uid}.${relation.field}`),
        ...ORGANISATION_RELATIONS,
      ]
        .filter((relation) => !existing.has(relation))
        .sort(),
    ).toEqual([]);
  });

  it("selects no secret", () => {
    for (const relation of CONTENT_RELATIONS) {
      expect(
        relation.select.filter((field) => SECRETS.includes(field)),
        relation.key,
      ).toEqual([]);
    }
    expect(ACCOUNT_FIELDS.filter((field) => SECRETS.includes(field))).toEqual([]);
  });

  it("copies every column of the account except the secrets", () => {
    const user = schemas().get(USER_UID)!;
    const columns = Object.entries(user.attributes)
      .filter(([, attribute]) => attribute.type !== "relation" && attribute.type !== "media")
      .map(([field]) => field);
    const copied = new Set<string>([...ACCOUNT_FIELDS, ...SECRETS]);
    expect(columns.filter((field) => !copied.has(field)).sort()).toEqual([]);
  });
});
