import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import { createStrapiStub, type Row } from "../test/strapi-stub.test.helper";
import {
  MAX_ANCESTOR_WALK,
  hasAncestor,
  pageSpace,
  wikiRelationChecks,
  type WikiWriteScope,
} from "./wiki-write-targets";
import type { StrapiDb, ToOneRelationInput } from "./write-allowlist";

/**
 * The wiki relation checks (FX07; the moderator class and the unchanged
 * parent of batch 16) on the shared stub. can-edit-wiki.test.ts drives the
 * same checks through the gate; here each rule on its own:
 *   - a space is usable when it has a published row and every row is
 *     visible (a moderator: any space with a published row);
 *   - a parent must sit in the page's space (the author classes: and have a
 *     published row), never be the page itself, and when it CHANGES never
 *     lie below the page (`parentCycle`);
 *   - a page's space is the one space every row sits in.
 */

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";
const PUBLISHED = "2026-09-01T00:00:00.000Z";

const spaceRows = (documentId: string, ids: [number, number | null]): Row[] => [
  { id: ids[0], documentId, publishedAt: null },
  ...(ids[1] === null ? [] : [{ id: ids[1], documentId, publishedAt: PUBLISHED }]),
];

/** A page document: draft and published rows in one space, with a parent. */
function page(
  documentId: string,
  ids: [number, number | null],
  space: [number, number],
  parent?: [number, number],
): Row[] {
  return [
    {
      id: ids[0],
      documentId,
      publishedAt: null,
      space: { id: space[0] },
      ...(parent ? { parent: { id: parent[0] } } : {}),
    },
    ...(ids[1] === null
      ? []
      : [
          {
            id: ids[1],
            documentId,
            publishedAt: PUBLISHED,
            space: { id: space[1] },
            ...(parent ? { parent: { id: parent[1] } } : {}),
          },
        ]),
  ];
}

const OPEN: [number, number] = [100, 101];
const HIDDEN: [number, number] = [110, 111];

function world() {
  return createStrapiStub({
    tables: {
      [SPACE]: [
        ...spaceRows("spaceopenxxxxxxxxxxxxxxx", OPEN),
        ...spaceRows("spacehiddenxxxxxxxxxxxxx", HIDDEN),
        ...spaceRows("spacedraftxxxxxxxxxxxxxx", [120, null]),
      ],
      [PAGE]: [
        ...page("pagerootxxxxxxxxxxxxxxxx", [200, 201], OPEN),
        ...page("pagechildxxxxxxxxxxxxxxx", [210, 211], OPEN, [200, 201]),
        ...page("pagegrandxxxxxxxxxxxxxxx", [220, 221], OPEN, [210, 211]),
        ...page("pagedraftxxxxxxxxxxxxxxx", [230, null], OPEN),
        ...page("pagesecretxxxxxxxxxxxxxx", [240, 241], HIDDEN),
        // A legacy loop: a <-> b.
        ...page("pageloopaxxxxxxxxxxxxxxx", [250, 251], OPEN, [260, 261]),
        ...page("pageloopbxxxxxxxxxxxxxxx", [260, 261], OPEN, [250, 251]),
      ],
    },
  });
}

const db = (stub: ReturnType<typeof world>) => stub as unknown as StrapiDb;
const target = (documentId: string): ToOneRelationInput => ({
  target: { documentId },
  disconnect: [],
});
const VISIBLE = new Set([...OPEN, 120]);

describe("wikiSpace", () => {
  it("takes a readable published space; a moderator any published space", async () => {
    const stub = world();
    const author = wikiRelationChecks(db(stub), { visibleSpaceIds: VISIBLE });
    const moderator = wikiRelationChecks(db(stub), { visibleSpaceIds: null });
    expect(await author.wikiSpace(target("spaceopenxxxxxxxxxxxxxxx"), {})).toEqual({
      target: "spaceopenxxxxxxxxxxxxxxx",
      disconnect: [],
    });
    expect(await author.wikiSpace(target("spacehiddenxxxxxxxxxxxxx"), {})).toBeNull();
    expect(await moderator.wikiSpace(target("spacehiddenxxxxxxxxxxxxx"), {})).toEqual({
      target: "spacehiddenxxxxxxxxxxxxx",
      disconnect: [],
    });
    for (const check of [author, moderator]) {
      expect(await check.wikiSpace(target("spacedraftxxxxxxxxxxxxxx"), {})).toBeNull();
      expect(await check.wikiSpace({ target: null, disconnect: [] }, {})).toBeNull();
    }
  });
});

describe("wikiParent", () => {
  const scope = (overrides: Partial<WikiWriteScope> = {}): WikiWriteScope => ({
    visibleSpaceIds: VISIBLE,
    pageDocumentId: "pagerootxxxxxxxxxxxxxxxx",
    spaceDocumentId: "spaceopenxxxxxxxxxxxxxxx",
    currentParentDocumentId: null,
    ...overrides,
  });

  it("takes a published page of the same space; a moderator a draft one too", async () => {
    const stub = world();
    const author = wikiRelationChecks(
      db(stub),
      scope({ pageDocumentId: "pagesecretxxxxxxxxxxxxxx" }),
    );
    expect(await author.wikiParent(target("pagerootxxxxxxxxxxxxxxxx"), {})).toEqual({
      target: "pagerootxxxxxxxxxxxxxxxx",
      disconnect: [],
    });
    expect(await author.wikiParent(target("pagedraftxxxxxxxxxxxxxxx"), {})).toBeNull();
    const moderator = wikiRelationChecks(
      db(stub),
      scope({ visibleSpaceIds: null, pageDocumentId: "pagesecretxxxxxxxxxxxxxx" }),
    );
    expect(await moderator.wikiParent(target("pagedraftxxxxxxxxxxxxxxx"), {})).toEqual({
      target: "pagedraftxxxxxxxxxxxxxxx",
      disconnect: [],
    });
    // Another space, for both.
    expect(await moderator.wikiParent(target("pagesecretxxxxxxxxxxxxxx"), {})).toBeNull();
  });

  it("refuses the page itself (invalid) and a NEW parent below it (parentCycle)", async () => {
    const stub = world();
    const check = wikiRelationChecks(db(stub), scope());
    expect(await check.wikiParent(target("pagerootxxxxxxxxxxxxxxxx"), {})).toBeNull();
    for (const below of ["pagechildxxxxxxxxxxxxxxx", "pagegrandxxxxxxxxxxxxxxx"]) {
      const error = await check.wikiParent(target(below), {}).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error, below).toBeInstanceOf(errors.ValidationError);
      expect((error as InstanceType<typeof errors.ValidationError>).details).toEqual({
        keys: ["parent"],
        codes: { parent: "parentCycle" },
      });
    }
  });

  it("does not walk for the stored parent: a save inside a legacy loop passes", async () => {
    const stub = world();
    const check = wikiRelationChecks(
      db(stub),
      scope({
        pageDocumentId: "pageloopaxxxxxxxxxxxxxxx",
        currentParentDocumentId: "pageloopbxxxxxxxxxxxxxxx",
      }),
    );
    expect(await check.wikiParent(target("pageloopbxxxxxxxxxxxxxxx"), {})).toEqual({
      target: "pageloopbxxxxxxxxxxxxxxx",
      disconnect: [],
    });
    // The same parent, not yet stored: the walk runs and finds the loop.
    const fresh = wikiRelationChecks(
      db(stub),
      scope({ pageDocumentId: "pageloopaxxxxxxxxxxxxxxx", currentParentDocumentId: null }),
    );
    await expect(fresh.wikiParent(target("pageloopbxxxxxxxxxxxxxxx"), {})).rejects.toBeInstanceOf(
      errors.ValidationError,
    );
  });

  it("on create takes the space checked just before", async () => {
    const stub = world();
    const check = wikiRelationChecks(db(stub), { visibleSpaceIds: VISIBLE });
    expect(
      await check.wikiParent(target("pagerootxxxxxxxxxxxxxxxx"), {
        space: { target: "spaceopenxxxxxxxxxxxxxxx", disconnect: [] },
      }),
    ).toEqual({ target: "pagerootxxxxxxxxxxxxxxxx", disconnect: [] });
    expect(await check.wikiParent(target("pagerootxxxxxxxxxxxxxxxx"), {})).toBeNull();
  });
});

describe("pageSpace and hasAncestor", () => {
  it("names the one space every row sits in, visible for the author classes", async () => {
    const stub = world();
    expect(await pageSpace(db(stub), "pagerootxxxxxxxxxxxxxxxx", VISIBLE)).toBe(
      "spaceopenxxxxxxxxxxxxxxx",
    );
    expect(await pageSpace(db(stub), "pagesecretxxxxxxxxxxxxxx", VISIBLE)).toBeNull();
    expect(await pageSpace(db(stub), "pagesecretxxxxxxxxxxxxxx", null)).toBe(
      "spacehiddenxxxxxxxxxxxxx",
    );
    expect(await pageSpace(db(stub), "pagenonexxxxxxxxxxxxxxxx", null)).toBeNull();
  });

  it("walks every row's parent, ends in a legacy loop, and refuses a chain too long to walk", async () => {
    const stub = world();
    expect(
      await hasAncestor(db(stub), "pagegrandxxxxxxxxxxxxxxx", "pagerootxxxxxxxxxxxxxxxx"),
    ).toBe(true);
    expect(
      await hasAncestor(db(stub), "pagerootxxxxxxxxxxxxxxxx", "pagegrandxxxxxxxxxxxxxxx"),
    ).toBe(false);
    expect(
      await hasAncestor(db(stub), "pageloopaxxxxxxxxxxxxxxx", "pagerootxxxxxxxxxxxxxxxx"),
    ).toBe(false);
    expect(MAX_ANCESTOR_WALK).toBe(1000);
  });
});
