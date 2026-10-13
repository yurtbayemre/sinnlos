import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS, AUDIT_ACTOR_KINDS, AUDIT_SOURCES } from "./audit";

const SCHEMA = JSON.parse(
  readFileSync(
    join(__dirname, "..", "api", "audit-event", "content-types", "audit-event", "schema.json"),
    "utf8",
  ),
) as { attributes: Record<string, { enum?: string[] }> };

describe("audit-event vocabulary (K4)", () => {
  it("matches the schema's enums", () => {
    expect(SCHEMA.attributes.action.enum).toEqual([...AUDIT_ACTIONS]);
    expect(SCHEMA.attributes.actorKind.enum).toEqual([...AUDIT_ACTOR_KINDS]);
    expect(SCHEMA.attributes.source.enum).toEqual([...AUDIT_SOURCES]);
  });
});
