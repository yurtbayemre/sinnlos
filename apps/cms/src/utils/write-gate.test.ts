import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import { createStrapiStub, policyContext, type StrapiStub } from "../test/strapi-stub.test.helper";
import {
  AUTHORING_STATE_KEY,
  authoringGateOf,
  departmentAuthorOwns,
  loadAuthoringRows,
  loadCallerDepartment,
  roleClassFor,
  rowInDepartmentScope,
  scopeClassifier,
  writeGate,
  type AuthoringGate,
  type WriteGateHost,
} from "./write-gate";

/**
 * The v2 write gate (decision 06 §B2, §N1, §N3; batch 15 lane 15A) on the
 * shared Strapi stub: the canonical draft loader (the draft whatever the
 * row order, a published row id resolved to its draft, the revision read
 * before any content row), the department author's class (role plus
 * department, ownership and scope on every row), the classifier the lock
 * re-runs, and the policy's outcomes and the state it hands on.
 */

const A = "api::announcement.announcement";
const E = "api::event.event";
const D = "api::document.document";
const Q = "api::quick-link.quick-link";
const USER = "plugin::users-permissions.user";
const DEPT = "api::department.department";
const TEAM = "api::team.team";
const ROLE = "plugin::users-permissions.role";
const VERSION = "api::content-version.content-version";

const ENG = { id: 10, documentId: "deng00000000000000000000" };
const SALES = { id: 11, documentId: "dsal00000000000000000000" };

const HEAD = { id: 103, role: { id: 3, type: "department_head" } };
const EDITOR = { id: 102, role: { id: 2, type: "editor" } };
const MEMBER = { id: 105, role: { id: 5, type: "member" } };

function world(): { strapi: StrapiStub; host: WriteGateHost } {
  const strapi = createStrapiStub({
    tables: {
      [USER]: [
        { id: 102, username: "ed", role: { id: 2 }, department: null },
        { id: 103, username: "head", role: { id: 3 }, department: { id: ENG.id } },
        { id: 104, username: "loner", role: { id: 3 }, department: null },
        { id: 105, username: "member", role: { id: 5 }, department: { id: ENG.id } },
      ],
      [DEPT]: [
        { id: ENG.id, documentId: ENG.documentId, name: "Engineering" },
        { id: SALES.id, documentId: SALES.documentId, name: "Sales" },
      ],
      [TEAM]: [
        {
          id: 30,
          documentId: "teng00000000000000000000",
          name: "Platform",
          department: { id: ENG.id },
        },
        {
          id: 31,
          documentId: "tsal00000000000000000000",
          name: "Field",
          department: { id: SALES.id },
        },
      ],
      [ROLE]: [
        { id: 3, documentId: "rdh0000000000000000000000", type: "department_head" },
        { id: 5, documentId: "rme0000000000000000000000", type: "member" },
        { id: 6, documentId: "rgu0000000000000000000000", type: "guest" },
      ],
    },
  });
  return { strapi, host: strapi as unknown as WriteGateHost };
}

/** An announcement owned by Engineering and in its scope, both rows. */
const ownedAnnouncement = (strapi: StrapiStub, extra: Record<string, unknown> = {}) =>
  strapi.seedDocument(
    A,
    {
      title: "Owned",
      department: { id: ENG.id },
      ownerDepartment: { id: ENG.id },
      audience: "departments",
      ...extra,
    },
    { status: "published" },
  );

describe("the canonical draft loader", () => {
  it("chooses the draft whatever the row order, and resolves a published row id to its draft", async () => {
    const { strapi, host } = world();
    const seeded = ownedAnnouncement(strapi);
    // Put the published row first in the table.
    strapi.tables[A].reverse();
    for (const ref of [seeded.documentId, String(seeded.published?.id), String(seeded.draft?.id)]) {
      const loaded = await loadAuthoringRows(host, A, ref);
      expect(loaded?.rows.documentId, ref).toBe(seeded.documentId);
      expect(loaded?.rows.draft?.id, ref).toBe(seeded.draft?.id);
      expect(loaded?.rows.published?.id, ref).toBe(seeded.published?.id);
    }
  });

  it("reads the revision before any content row", async () => {
    const { strapi, host } = world();
    const seeded = ownedAnnouncement(strapi);
    strapi.tables[VERSION] = [
      { id: 1, documentId: "v1", targetUid: A, targetDocumentId: seeded.documentId, revision: 4 },
    ];
    strapi.calls.length = 0;
    const loaded = await loadAuthoringRows(host, A, seeded.documentId);
    expect(loaded?.observedRevision).toBe(4);
    const order = strapi.calls.map((call) => call.uid);
    expect(order.indexOf(VERSION)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(VERSION)).toBeLessThan(order.indexOf(A));
  });

  it("answers null for a malformed ref, a missing document and one without a draft row", async () => {
    const { strapi, host } = world();
    for (const ref of ["", "abc", "2147483648", "zzzzzzzzzzzzzzzzzzzzzzzz", "999"]) {
      expect(await loadAuthoringRows(host, A, ref), ref).toBeNull();
    }
    strapi.tables[A] = [
      { id: 7, documentId: "pub0000000000000000000000", publishedAt: "2026-01-01T00:00:00Z" },
    ];
    expect(await loadAuthoringRows(host, A, "pub0000000000000000000000")).toBeNull();
  });
});

describe("the department author's class (§N1, §N3)", () => {
  it("needs the role, a department-authored type and the caller's department", async () => {
    const { host } = world();
    expect(roleClassFor(EDITOR, Q)).toBe("moderator");
    expect(roleClassFor(HEAD, A)).toBe("departmentAuthor");
    expect(roleClassFor(HEAD, Q)).toBeNull();
    expect(roleClassFor(HEAD, "api::poll.poll")).toBeNull();
    expect(roleClassFor(MEMBER, A)).toBeNull();
    expect(roleClassFor({ role: { type: "Department_head" } }, A)).toBeNull();
    expect(await loadCallerDepartment(host, 103)).toEqual(ENG);
    expect(await loadCallerDepartment(host, 104)).toBeNull();
  });

  it("owns a row only when owned by and in the scope of the department, on every row", async () => {
    const { strapi, host } = world();
    const owned = ownedAnnouncement(strapi, { team: { id: 30 }, audienceRoles: [{ id: 5 }] });
    const rows = (await loadAuthoringRows(host, A, owned.documentId))!.rows;
    expect(departmentAuthorOwns(A, rows, ENG)).toBe(true);
    expect(departmentAuthorOwns(A, rows, SALES)).toBe(false);
    expect(departmentAuthorOwns(A, rows, null)).toBe(false);

    const cases: [string, Record<string, unknown>][] = [
      ["moderator-owned", { ownerDepartment: null }],
      ["another department's", { department: { id: SALES.id }, ownerDepartment: { id: SALES.id } }],
      ["widened to everyone", { department: null, audience: "all" }],
      ["a team of another department", { team: { id: 31 } }],
      ["a non-staff audience role", { audienceRoles: [{ id: 6 }] }],
    ];
    for (const [label, change] of cases) {
      const { strapi: s2, host: h2 } = world();
      const seeded = ownedAnnouncement(s2, change);
      const loaded = (await loadAuthoringRows(h2, A, seeded.documentId))!.rows;
      expect(departmentAuthorOwns(A, loaded, ENG), label).toBe(false);
    }
  });

  it("checks the published twin too: a widened published row takes the item away", async () => {
    const { strapi, host } = world();
    const seeded = ownedAnnouncement(strapi);
    const published = strapi.tables[A].find((row) => row.id === seeded.published?.id)!;
    published.department = { id: SALES.id };
    const rows = (await loadAuthoringRows(host, A, seeded.documentId))!.rows;
    expect(rowInDepartmentScope(A, rows.draft!, ENG)).toBe(true);
    expect(departmentAuthorOwns(A, rows, ENG)).toBe(false);
  });

  it("events and documents need exactly the one department", async () => {
    const { strapi, host } = world();
    for (const uid of [E, D]) {
      const one = strapi.seedDocument(uid, {
        title: "x",
        start: "2026-12-01T09:00:00.000Z",
        departments: [{ id: ENG.id }],
        ownerDepartment: { id: ENG.id },
      });
      const two = strapi.seedDocument(uid, {
        title: "y",
        start: "2026-12-01T09:00:00.000Z",
        departments: [{ id: ENG.id }, { id: SALES.id }],
        ownerDepartment: { id: ENG.id },
      });
      const none = strapi.seedDocument(uid, {
        title: "z",
        start: "2026-12-01T09:00:00.000Z",
        departments: [],
        ownerDepartment: { id: ENG.id },
      });
      const owns = async (documentId: string) =>
        departmentAuthorOwns(uid, (await loadAuthoringRows(host, uid, documentId))!.rows, ENG);
      expect(await owns(one.documentId), uid).toBe(true);
      expect(await owns(two.documentId), uid).toBe(false);
      expect(await owns(none.documentId), uid).toBe(false);
    }
  });
});

describe("the classifier the lock re-runs (amendment row A2)", () => {
  it("answers the class on the rows as they are now, null when gone or out of scope", async () => {
    const { strapi, host } = world();
    const seeded = ownedAnnouncement(strapi);
    const head = scopeClassifier(host, "departmentAuthor", ENG);
    const moderator = scopeClassifier(host, "moderator", null);
    const target = { uid: A, documentId: seeded.documentId };
    expect(await head(target)).toBe("departmentAuthor");
    expect(await moderator(target)).toBe("moderator");
    for (const row of strapi.tables[A]) row.ownerDepartment = null;
    expect(await head(target)).toBeNull();
    expect(await moderator(target)).toBe("moderator");
    strapi.tables[A] = [];
    expect(await moderator(target)).toBeNull();
  });
});

describe("global::can-author", () => {
  const gate = writeGate();
  const run = async (
    strapi: StrapiStub,
    user: object | null,
    config: Record<string, unknown>,
    options: { params?: Record<string, unknown>; body?: unknown } = {},
  ) => {
    const ctx = policyContext(user as never, { ...options });
    try {
      return { result: await gate(ctx as never, config, { strapi: strapi as never }), ctx };
    } catch (error) {
      return { error, ctx };
    }
  };

  it("hands the controller the class, the document, its observed revision and the classifier", async () => {
    const { strapi } = world();
    const seeded = ownedAnnouncement(strapi);
    const { result, ctx } = await run(
      strapi,
      HEAD,
      { uid: A, intent: "publish" },
      {
        params: { id: seeded.documentId },
      },
    );
    expect(result).toBe(true);
    const state = authoringGateOf(ctx.state) as AuthoringGate;
    expect(state).toMatchObject({
      uid: A,
      intent: "publish",
      roleClass: "departmentAuthor",
      callerId: 103,
      callerDepartment: ENG,
      documentId: seeded.documentId,
      observedRevision: 0,
    });
    expect(typeof state.classify).toBe("function");
    expect(ctx.state).toHaveProperty(AUTHORING_STATE_KEY);
  });

  it("refuses with 404 on a custom document action and false on the generic update", async () => {
    const { strapi } = world();
    const moderatorOwned = strapi.seedDocument(
      A,
      { title: "Mod", department: { id: ENG.id } },
      { status: "published" },
    );
    const custom = await run(
      strapi,
      HEAD,
      { uid: A, intent: "editable" },
      { params: { id: moderatorOwned.documentId } },
    );
    expect(custom.error).toBeInstanceOf(errors.NotFoundError);
    const generic = await run(
      strapi,
      HEAD,
      { uid: A },
      {
        params: { id: moderatorOwned.documentId },
        body: { data: { title: "x" } },
      },
    );
    expect(generic.result).toBe(false);
  });

  it("refuses a head without a department, a head on quick links, a member, a route without a uid", async () => {
    const { strapi } = world();
    expect(
      (
        await run(
          strapi,
          { id: 104, role: { type: "department_head" } },
          { uid: A },
          { body: { data: { title: "x" } } },
        )
      ).result,
    ).toBe(false);
    expect(
      (await run(strapi, HEAD, { uid: Q }, { body: { data: { label: "x", url: "/x" } } })).result,
    ).toBe(false);
    expect((await run(strapi, MEMBER, { uid: A }, { body: { data: { title: "x" } } })).result).toBe(
      false,
    );
    expect((await run(strapi, EDITOR, {}, { body: { data: { title: "x" } } })).result).toBe(false);
    expect(
      (
        await run(
          strapi,
          EDITOR,
          { uid: "api::wiki-page.wiki-page" },
          { body: { data: { title: "x" } } },
        )
      ).result,
    ).toBe(false);
    expect(
      (await run(strapi, EDITOR, { uid: A, intent: "bogus" }, { body: { data: {} } })).result,
    ).toBe(false);
    const list = await run(
      strapi,
      { id: 104, role: { type: "department_head" } },
      { uid: A, intent: "authoringList" },
    );
    expect(list.result).toBe(false);
  });

  it("enforces the class's rule on create and leaves the status to the controller", async () => {
    const { strapi } = world();
    const ctx = policyContext(HEAD as never, {
      body: { data: { title: "Hi" } },
      query: { status: "draft" },
    });
    expect(await gate(ctx as never, { uid: A }, { strapi: strapi as never })).toBe(true);
    expect(ctx.request.query).toEqual({ status: "draft" });
    expect(ctx.request.body).toEqual({
      data: {
        title: "Hi",
        department: { set: [{ documentId: ENG.documentId }] },
        audience: "departments",
        retargetRequired: false,
        ownerDepartment: { set: [{ documentId: ENG.documentId }] },
        author: 103,
      },
    });
    const refused = policyContext(HEAD as never, { body: { data: { title: "Hi", pinned: true } } });
    await expect(
      gate(refused as never, { uid: A }, { strapi: strapi as never }),
    ).rejects.toBeInstanceOf(errors.ValidationError);
  });

  it("passes moderators to the list without reading anything", async () => {
    const { strapi } = world();
    strapi.calls.length = 0;
    const { result } = await run(strapi, EDITOR, { uid: Q, intent: "authoringList" });
    expect(result).toBe(true);
    expect(strapi.calls).toEqual([]);
  });
});
