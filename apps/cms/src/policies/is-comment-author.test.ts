import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import {
  createStrapiStub,
  policyContext,
  type StrapiStub,
  type StubUser,
} from "../test/strapi-stub.test.helper";
import { MALFORMED_ENTRY_IDS } from "../utils/entry-id.test.helper";
import isCommentAuthor from "./is-comment-author";

/**
 * The comment delete gate (PL03): the author, admin_role and editor pass;
 * everyone else is refused with the answer the comment controller gave
 * before the check moved into this policy: a thrown
 * ForbiddenError("Forbidden") (ctx.forbidden()'s body), never Strapi's
 * PolicyError ("Policy Failed"). A `:id` that names no comment passes on to
 * the controller, whose 404 it always got. The HTTP answers are pinned byte
 * for byte in integration/comment-delete.integration.test.ts.
 */

const COMMENT = "api::comment.comment";
const AUTHOR = 5;
const STRANGER = 6;
const OWN_DOC = "cmown0000000000000000000";
const ORPHAN_DOC = "cmnoauthor00000000000000";

function stub(): StrapiStub {
  return createStrapiStub({
    tables: {
      "plugin::users-permissions.user": [
        { id: AUTHOR, username: "author" },
        { id: STRANGER, username: "stranger" },
      ],
      [COMMENT]: [
        { id: 1, documentId: OWN_DOC, body: "mine", author: { id: AUTHOR } },
        { id: 2, documentId: ORPHAN_DOC, body: "author deleted", author: null },
      ],
    },
  });
}

const as = (type: string, id?: number): StubUser =>
  id === undefined ? { role: { type } } : { id, role: { type } };

type Outcome = { result: boolean; calls: number } | { error: unknown; calls: number };

async function run(user: StubUser | null | undefined, id: unknown): Promise<Outcome> {
  const strapi = stub();
  const ctx = policyContext(user, { params: { id }, query: { filters: { a: 1 } } });
  try {
    const result = await isCommentAuthor(ctx, undefined, { strapi });
    expect(ctx.request.query).toEqual({ filters: { a: 1 } });
    return { result, calls: strapi.calls.length };
  } catch (error) {
    return { error, calls: strapi.calls.length };
  }
}

/** The refusal: ctx.forbidden()'s error, not a PolicyError. */
function expectForbidden(outcome: Outcome, label: string) {
  expect("error" in outcome, label).toBe(true);
  if (!("error" in outcome)) return;
  expect(outcome.error, label).toBeInstanceOf(errors.ForbiddenError);
  expect(outcome.error, label).not.toBeInstanceOf(errors.PolicyError);
  expect(outcome.error, label).toMatchObject({
    name: "ForbiddenError",
    message: "Forbidden",
    details: {},
  });
}

describe("is-comment-author policy (PL03)", () => {
  it("passes the author by numeric id and by documentId", async () => {
    for (const id of ["1", 1, OWN_DOC]) {
      await expect(run(as("member", AUTHOR), id)).resolves.toMatchObject({ result: true });
    }
  });

  it("refuses a stranger with the controller's former 403", async () => {
    for (const type of ["member", "department_head", "team_lead", "authenticated", "guest"]) {
      for (const id of ["1", OWN_DOC]) {
        expectForbidden(await run(as(type, STRANGER), id), `${type} ${id}`);
      }
    }
  });

  it("lets admin_role and editor delete any comment, without a lookup", async () => {
    for (const type of ["admin_role", "editor"]) {
      for (const id of ["1", "2", OWN_DOC, "99"]) {
        await expect(run(as(type, STRANGER), id), `${type} ${id}`).resolves.toEqual({
          result: true,
          calls: 0,
        });
      }
    }
  });

  it("passes an id that names no comment on to the controller's 404", async () => {
    for (const id of ["99", "zz0000000000000000000000"]) {
      await expect(run(as("member", AUTHOR), id), id).resolves.toEqual({ result: true, calls: 1 });
    }
    // Malformed or out of range: passed on before any lookup, and the
    // controller's findByRef answers 404 without one as well.
    for (const id of [...MALFORMED_ENTRY_IDS, undefined]) {
      await expect(run(as("member", AUTHOR), id), String(id)).resolves.toEqual({
        result: true,
        calls: 0,
      });
    }
  });

  it("gives nobody a comment whose author is gone, except the moderators", async () => {
    expectForbidden(await run(as("member", AUTHOR), "2"), "member");
    await expect(run(as("editor", STRANGER), "2")).resolves.toMatchObject({ result: true });
  });

  it("refuses a caller without a numeric id before any lookup, even for an unknown id", async () => {
    for (const id of ["1", "2", "99", "abc"]) {
      const outcome = await run(as("member"), id);
      expectForbidden(outcome, id);
      expect(outcome.calls, id).toBe(0);
    }
  });

  it("refuses a request without a signed-in user", async () => {
    for (const user of [undefined, null]) {
      const outcome = await run(user, "1");
      expectForbidden(outcome, String(user));
      expect(outcome.calls).toBe(0);
    }
  });

  it("reads lookalike role spellings as no role (no bypass)", async () => {
    for (const type of ["Admin_role", "ADMIN_ROLE", "admin", " editor", "Editor", "public"]) {
      expectForbidden(await run(as(type, STRANGER), "1"), type);
    }
  });
});
