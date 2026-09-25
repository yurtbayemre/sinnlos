import { beforeEach, describe, expect, it, vi } from "vitest";
import { wikiEditContext, type WikiEditContext } from "../../../utils/wiki-edit-context";
import wikiPageController from "./wiki-page";

/**
 * wiki-page update controller invariants (docs/architecture.md §5.23), next
 * to the FX07 allowlist that now runs before it in can-edit-wiki:
 *   - `revisionSummary` is not a schema attribute (the core validateInput
 *     would reject it), so the controller strips it and hands it to the
 *     revision lifecycle through wikiEditContext. The allowlist admits it
 *     as controller input for exactly this reason.
 *   - super.update runs INSIDE wikiEditContext.run, so beforeUpdate sees the
 *     editor.
 *   - lastEditor is server-authoritative for every caller (the allowlist
 *     refuses it from non-bypass callers; for admin/editor it is overwritten).
 *
 * `super.update` is a spy on the prototype, where @strapi/core puts the base
 * controller (comment.test.ts pattern); it records the payload and the
 * AsyncLocalStorage store it runs under.
 */

const mocks = vi.hoisted(() => ({
  seen: [] as { data: unknown; store: unknown }[],
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), {
          update: async (ctx: FakeCtx) => {
            mocks.seen.push({
              data: structuredClone(ctx.request.body.data),
              store: structuredClone(wikiEditContext.getStore()),
            });
            return { data: {} };
          },
        }),
  },
}));

interface FakeCtx {
  request: { body: { data: Record<string, unknown> } };
  state: { user?: { id: number; role: { type: string } } };
}

type WikiPageController = { update(ctx: FakeCtx): Promise<unknown> };

function controller(): WikiPageController {
  return (wikiPageController as unknown as (deps: { strapi: unknown }) => WikiPageController)({
    strapi: {},
  });
}

const AUTHOR = { id: 7, role: { type: "member" } };

beforeEach(() => {
  mocks.seen.length = 0;
});

describe("wiki-page update controller", () => {
  it("strips revisionSummary, forces lastEditor and runs super.update in the edit context", async () => {
    // The shape can-edit-wiki hands over for a non-bypass author.
    const data = {
      title: "Neu",
      parent: { set: [{ documentId: "page-sibling" }] },
      revisionSummary: "Tippfehler",
    };
    await controller().update({ request: { body: { data } }, state: { user: AUTHOR } });
    expect(mocks.seen).toEqual([
      {
        data: {
          title: "Neu",
          parent: { set: [{ documentId: "page-sibling" }] },
          lastEditor: AUTHOR.id,
        },
        store: { editorId: AUTHOR.id, revisionSummary: "Tippfehler" } satisfies WikiEditContext,
      },
    ]);
  });

  it("drops a null revisionSummary without passing it on", async () => {
    await controller().update({
      request: { body: { data: { body: "x", revisionSummary: null } } },
      state: { user: AUTHOR },
    });
    expect(mocks.seen[0].data).toEqual({ body: "x", lastEditor: AUTHOR.id });
    expect(mocks.seen[0].store).toEqual({ editorId: AUTHOR.id, revisionSummary: undefined });
  });

  it("overwrites a client lastEditor for bypass callers too", async () => {
    const editor = { id: 3, role: { type: "editor" } };
    await controller().update({
      request: { body: { data: { lastEditor: 99, title: "x" } } },
      state: { user: editor },
    });
    expect(mocks.seen[0].data).toEqual({ title: "x", lastEditor: editor.id });
  });
});
