import { describe, expect, it } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import { authoringChecks, pollHasVotes, type AuthoringChecksHost } from "./authoring-checks";
import type { RelationRef, ToOneRelationInput } from "./write-allowlist";

/**
 * The database-backed checks of the v2 write gate (decision 06 §B1.2, §E2,
 * §N4; batch 15 lane 15A) on the shared Strapi stub. Every refusal is a
 * null, which the allowlist turns into its generic 400 without a code, so
 * a missing, foreign or out-of-scope target looks like a malformed one.
 */

const DEPT = "api::department.department";
const TEAM = "api::team.team";
const ROLE = "plugin::users-permissions.role";
const FILE = "plugin::upload.file";
const POLL = "api::poll.poll";
const VOTE = "api::poll-vote.poll-vote";
const DOCUMENT = "api::document.document";

const ENG = { id: 10, documentId: "deng00000000000000000000" };
const SALES = { id: 11, documentId: "dsal00000000000000000000" };

function world(): StrapiStub {
  return createStrapiStub({
    tables: {
      [DEPT]: [
        { id: ENG.id, documentId: ENG.documentId, name: "Engineering" },
        { id: SALES.id, documentId: SALES.documentId, name: "Sales" },
      ],
      [TEAM]: [
        { id: 30, documentId: "teng00000000000000000000", department: { id: ENG.id } },
        { id: 31, documentId: "tsal00000000000000000000", department: { id: SALES.id } },
        { id: 32, documentId: "tnon00000000000000000000", department: null },
      ],
      [ROLE]: [
        { id: 1, documentId: "radm0000000000000000000000", type: "admin_role" },
        { id: 5, documentId: "rmem0000000000000000000000", type: "member" },
        { id: 7, documentId: "rpub0000000000000000000000", type: "public" },
      ],
      [FILE]: [
        { id: 1, name: "a.pdf", mime: "application/pdf", provider_metadata: { uploadedBy: 42 } },
        { id: 2, name: "b.pdf", mime: "application/pdf", provider_metadata: { uploadedBy: 7 } },
        {
          id: 3,
          name: "c.exe",
          mime: "application/x-msdownload",
          provider_metadata: { uploadedBy: 42 },
        },
        { id: 4, name: "d.pdf", mime: "application/pdf", provider_metadata: null },
      ],
    },
  });
}

const checks = (strapi: StrapiStub, department: typeof ENG | null = ENG) =>
  authoringChecks(strapi as unknown as AuthoringChecksHost, {
    callerId: 42,
    callerDepartment: department,
    uid: DOCUMENT,
    documentId: "doc00000000000000000000a",
    ownRowIds: [100, 101],
  });

const to = (
  target: RelationRef | null | undefined,
  disconnect: RelationRef[] = [],
): ToOneRelationInput => ({
  target,
  disconnect,
});

describe("relations", () => {
  it("department and team resolve any existing row to its documentId, by id or documentId", async () => {
    const { relationChecks } = checks(world(), null);
    expect(await relationChecks.department?.(to({ id: SALES.id }), {})).toEqual({
      target: SALES.documentId,
      disconnect: [],
    });
    expect(await relationChecks.team?.(to({ documentId: "tsal00000000000000000000" }), {})).toEqual(
      {
        target: "tsal00000000000000000000",
        disconnect: [],
      },
    );
    expect(await relationChecks.department?.(to(null), {})).toEqual({
      target: null,
      disconnect: [],
    });
    expect(await relationChecks.department?.(to({ id: 999 }), {})).toBeNull();
    expect(await relationChecks.department?.(to(undefined, [{ id: 999 }]), {})).toBeNull();
  });

  it("callerDepartment: exactly the caller's department; never null, another one or a disconnect", async () => {
    const { relationChecks } = checks(world());
    expect(await relationChecks.callerDepartment?.(to({ documentId: ENG.documentId }), {})).toEqual(
      {
        target: ENG.documentId,
        disconnect: [],
      },
    );
    expect(await relationChecks.callerDepartment?.(to({ id: ENG.id }), {})).toEqual({
      target: ENG.documentId,
      disconnect: [],
    });
    expect(await relationChecks.callerDepartment?.(to({ id: SALES.id }), {})).toBeNull();
    expect(await relationChecks.callerDepartment?.(to(null), {})).toBeNull();
    expect(await relationChecks.callerDepartment?.(to(undefined, [{ id: ENG.id }]), {})).toBeNull();
    expect(await relationChecks.callerDepartment?.(to({ id: 999 }), {})).toBeNull();
    // Without a department (a moderator's checks) the check refuses everything.
    expect(
      await checks(world(), null).relationChecks.callerDepartment?.(to({ id: ENG.id }), {}),
    ).toBeNull();
  });

  it("teamOfCallerDepartment: null, or a team whose department is the caller's", async () => {
    const { relationChecks } = checks(world());
    expect(await relationChecks.teamOfCallerDepartment?.(to(null), {})).toEqual({
      target: null,
      disconnect: [],
    });
    expect(await relationChecks.teamOfCallerDepartment?.(to({ id: 30 }), {})).toEqual({
      target: "teng00000000000000000000",
      disconnect: [],
    });
    expect(await relationChecks.teamOfCallerDepartment?.(to({ id: 31 }), {})).toBeNull();
    expect(await relationChecks.teamOfCallerDepartment?.(to({ id: 32 }), {})).toBeNull();
  });

  it("departments resolves and dedupes; callerDepartments is exactly [the caller's]", async () => {
    const { relationListChecks } = checks(world());
    expect(
      await relationListChecks.departments?.([
        { id: ENG.id },
        { documentId: SALES.documentId },
        { id: ENG.id },
      ]),
    ).toEqual([ENG.documentId, SALES.documentId]);
    expect(await relationListChecks.departments?.([{ id: 999 }])).toBeNull();
    expect(await relationListChecks.callerDepartments?.([{ id: ENG.id }])).toEqual([
      ENG.documentId,
    ]);
    expect(
      await relationListChecks.callerDepartments?.([
        { id: ENG.id },
        { documentId: ENG.documentId },
      ]),
    ).toEqual([ENG.documentId]);
    expect(await relationListChecks.callerDepartments?.([])).toBeNull();
    expect(await relationListChecks.callerDepartments?.([{ id: SALES.id }])).toBeNull();
    expect(
      await relationListChecks.callerDepartments?.([{ id: ENG.id }, { id: SALES.id }]),
    ).toBeNull();
  });
});

describe("role types", () => {
  it("resolves intranet role types to their role documentIds, in order; refuses the rest", async () => {
    const { roleTypesCheck } = checks(world());
    expect(await roleTypesCheck(["member", "admin_role"])).toEqual([
      "rmem0000000000000000000000",
      "radm0000000000000000000000",
    ]);
    expect(await roleTypesCheck(["public"])).toBeNull();
    expect(await roleTypesCheck(["authenticated"])).toBeNull();
    // A seeded type without a row (a database that lost it) refuses the field.
    expect(await roleTypesCheck(["team_lead"])).toBeNull();
  });
});

describe("ownUpload (§E2)", () => {
  it("needs the caller's stamp, an allowed mime and no link but the document's own rows", async () => {
    const strapi = world();
    const { mediaChecks } = checks(strapi);
    expect(await mediaChecks.ownUpload?.(1)).toBe(1);
    expect(await mediaChecks.ownUpload?.(2)).toBeNull();
    expect(await mediaChecks.ownUpload?.(3)).toBeNull();
    expect(await mediaChecks.ownUpload?.(4)).toBeNull();
    expect(await mediaChecks.ownUpload?.(999)).toBeNull();
    strapi.tables[FILE][0].related = [{ id: 100, __type: DOCUMENT }];
    expect(await mediaChecks.ownUpload?.(1)).toBe(1);
    strapi.tables[FILE][0].related = [{ id: 555, __type: DOCUMENT }];
    expect(await mediaChecks.ownUpload?.(1)).toBeNull();
    strapi.tables[FILE][0].related = [{ id: 100, __type: "api::classified.classified" }];
    expect(await mediaChecks.ownUpload?.(1)).toBeNull();
  });
});

describe("pollHasVotes", () => {
  it("counts the ballots of every row of the poll document", async () => {
    const strapi = world();
    strapi.tables[POLL] = [
      { id: 1, documentId: "poll0000000000000000000a", publishedAt: null },
      { id: 2, documentId: "poll0000000000000000000a", publishedAt: "2026-01-01T00:00:00Z" },
    ];
    const host = strapi as unknown as AuthoringChecksHost;
    expect(await pollHasVotes(host, "poll0000000000000000000a")).toBe(false);
    strapi.tables[VOTE] = [{ id: 1, poll: { id: 2 }, optionIndex: 0 }];
    expect(await pollHasVotes(host, "poll0000000000000000000a")).toBe(true);
    // No document yet (a create): nothing can be frozen.
    const none = authoringChecks(host, {
      callerId: 42,
      callerDepartment: null,
      uid: POLL,
      ownRowIds: [],
    });
    expect(await none.frozenChecks.pollHasVotes?.()).toBe(false);
  });
});
