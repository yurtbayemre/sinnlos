import { errors } from "@strapi/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addedEdges,
  createWikiChecks,
  loopThrough,
  namesSpace,
  type ParentEdge,
  type WikiChecksHost,
} from "./wiki-checks";

/**
 * The wiki checks (batch 16 plan S2, S15; lane 16B item 5): the edge diff
 * on the document-level parent graph (pure), and the Document Service
 * middleware on a fake database whose link rows the test's `next()`
 * changes, as the action would. The structure lock is a recorded spy (the
 * lock row itself is document-lock.ts's, exercised on both engines by
 * wiki-checks.integration.test.ts).
 */

const events = vi.hoisted(() => [] as string[]);
vi.mock("./wiki-structure-lock", () => ({
  lockWikiStructure: vi.fn(async () => {
    events.push("lock");
  }),
}));

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";

beforeEach(() => {
  events.length = 0;
});

const e = (child: string, parent: string): ParentEdge => [child, parent];

describe("the edge diff", () => {
  it("lists the edges an action added, once", () => {
    expect(addedEdges([e("a", "b")], [e("a", "b"), e("c", "a"), e("c", "a")])).toEqual([
      e("c", "a"),
    ]);
    expect(addedEdges([e("a", "b"), e("c", "a")], [e("a", "b")])).toEqual([]);
  });

  it("refuses a self-edge and a new edge into the page's own subtree", () => {
    expect(loopThrough([e("a", "a")], [e("a", "a")])).toEqual(e("a", "a"));
    // b and c sit below a; a's new parent c closes a -> c -> b -> a.
    const after = [e("b", "a"), e("c", "b"), e("a", "c")];
    expect(loopThrough(after, [e("a", "c")])).toEqual(e("a", "c"));
  });

  it("passes a diamond and two twins with one parent", () => {
    // The draft of d points at b, its published row at c; both below a.
    const diamond = [e("b", "a"), e("c", "a"), e("d", "b"), e("d", "c")];
    expect(loopThrough(diamond, addedEdges([e("b", "a"), e("c", "a"), e("d", "b")], diamond))).toBe(
      null,
    );
    expect(loopThrough([e("x", "p"), e("x", "p")], [e("x", "p")])).toBe(null);
  });

  it("never refuses for a legacy loop the action did not add to", () => {
    const legacy = [e("l1", "l2"), e("l2", "l1")];
    // An unrelated edge elsewhere.
    expect(
      loopThrough([...legacy, e("q", "r")], addedEdges(legacy, [...legacy, e("q", "r")])),
    ).toBe(null);
    // The repair: an edge of the loop removed.
    expect(addedEdges(legacy, [e("l1", "l2")])).toEqual([]);
    // A title-only save inside the loop adds no edge.
    expect(addedEdges(legacy, legacy)).toEqual([]);
  });

  it("catches an edge an action added to ANOTHER page (a discard re-creating incoming links)", () => {
    // Codex's interleaving: A -> D, published B -> A; D's new draft -> B and
    // a discard of A that re-links B's draft to A.
    const before = [e("A", "D"), e("D", "B")];
    const after = [e("A", "D"), e("D", "B"), e("B", "A")];
    expect(loopThrough(after, addedEdges(before, after))).toEqual(e("B", "A"));
  });
});

describe("namesSpace", () => {
  it.each([
    ["a documentId", "abc", true],
    ["a row id", 4, true],
    ["{ set: [ref] }", { set: [{ documentId: "abc" }] }, true],
    ["a panel connect", { connect: [{ id: 4 }], disconnect: [] }, true],
    ["{ documentId }", { documentId: "abc" }, true],
    ["a list", [4], true],
    ["null", null, false],
    ["{ set: [] }", { set: [] }, false],
    ["a panel no-op", { connect: [], disconnect: [] }, false],
    ["a disconnect", { disconnect: [{ id: 4 }] }, false],
  ] as const)("%s → %s", (_label, space, expected) => {
    expect(namesSpace({ space })).toBe(expected);
  });

  it("is false without the key", () => {
    expect(namesSpace({ title: "x" })).toBe(false);
    expect(namesSpace(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The middleware on a fake database.

interface World {
  /** wiki-page rows: id, documentId, draft or not. */
  pages: { id: number; documentId: string; publishedAt: string | null }[];
  /** Parent link rows (row ids). */
  parent: { child: number; parent: number }[];
  /** Space link rows (page row id → space row id). */
  space: { page: number; space: number }[];
  spaces: { id: number; documentId: string; publishedAt: string | null }[];
}

function fakeHost(world: World): WikiChecksHost {
  const where = (row: Record<string, unknown>, clause: Record<string, unknown> = {}) =>
    Object.entries(clause).every(([key, value]) => {
      if (value && typeof value === "object" && "$in" in value) {
        return (value as { $in: unknown[] }).$in.includes(row[key]);
      }
      if (value && typeof value === "object" && "$null" in value) return row[key] === null;
      if (value && typeof value === "object" && "$notNull" in value) return row[key] !== null;
      return row[key] === value;
    });
  const tableOf = (uid: string): Record<string, unknown>[] => {
    switch (uid) {
      case PAGE:
        return world.pages;
      case SPACE:
        return world.spaces;
      case "parent_lnk":
        return world.parent;
      case "space_lnk":
        return world.space;
      default:
        return [];
    }
  };
  return {
    db: {
      query: (uid: string) => ({
        findMany: async (params: Record<string, unknown>) =>
          tableOf(uid).filter((row) => where(row, params.where as Record<string, unknown>)),
        findOne: async (params: Record<string, unknown>) => {
          const row = tableOf(uid).find((candidate) =>
            where(candidate, params.where as Record<string, unknown>),
          );
          if (!row) return null;
          if (uid !== PAGE) return row;
          const link = world.space.find((candidate) => candidate.page === row.id);
          return { ...row, space: link ? { id: link.space } : null };
        },
        count: async (params: Record<string, unknown>) =>
          tableOf(uid).filter((row) => where(row, params.where as Record<string, unknown>)).length,
      }),
      metadata: {
        get: (uid: string) =>
          uid === PAGE
            ? {
                tableName: "wiki_pages",
                attributes: {
                  parent: {
                    joinTable: {
                      name: "parent_lnk",
                      joinColumn: { name: "child" },
                      inverseJoinColumn: { name: "parent" },
                    },
                  },
                  space: {
                    joinTable: {
                      name: "space_lnk",
                      joinColumn: { name: "page" },
                      inverseJoinColumn: { name: "space" },
                    },
                  },
                },
              }
            : { tableName: "x", attributes: {} },
      },
      transaction: async <T>(callback: (scope: { trx: unknown }) => Promise<T>) =>
        callback({ trx: undefined }),
      inTransaction: () => true,
    },
  } as unknown as WikiChecksHost;
}

/** Two published pages in one space, a page without a parent; b's parent is a. */
function world(): World {
  return {
    pages: [
      { id: 1, documentId: "a", publishedAt: null },
      { id: 2, documentId: "a", publishedAt: "2026-01-01" },
      { id: 3, documentId: "b", publishedAt: null },
      { id: 4, documentId: "b", publishedAt: "2026-01-01" },
      { id: 5, documentId: "c", publishedAt: null },
    ],
    parent: [
      { child: 3, parent: 1 },
      { child: 4, parent: 2 },
    ],
    space: [
      { page: 1, space: 10 },
      { page: 2, space: 11 },
      { page: 3, space: 10 },
      { page: 4, space: 11 },
      { page: 5, space: 10 },
    ],
    spaces: [
      { id: 10, documentId: "s1", publishedAt: null },
      { id: 11, documentId: "s1", publishedAt: "2026-01-01" },
      { id: 12, documentId: "s-empty", publishedAt: null },
      { id: 13, documentId: "s-draft-only", publishedAt: null },
    ],
  };
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(errors.ValidationError);
  return (error as InstanceType<typeof errors.ValidationError>).details;
};

describe("createWikiChecks", () => {
  it("takes the structure lock on every mutating wiki-page action, before the action", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    for (const action of [
      "create",
      "update",
      "clone",
      "publish",
      "unpublish",
      "discardDraft",
      "delete",
    ]) {
      events.length = 0;
      await checks({ uid: PAGE, action, params: { documentId: "a" } }, async () => {
        events.push("action");
        return { documentId: "a" };
      });
      expect(events, action).toEqual(["lock", "action"]);
    }
    for (const action of ["findMany", "findOne", "count"]) {
      events.length = 0;
      await checks({ uid: PAGE, action, params: {} }, async () => null);
      expect(events, action).toEqual([]);
    }
  });

  it("refuses an action that closes a loop with parentCycle, for every source", async () => {
    const state = world();
    const checks = createWikiChecks(fakeHost(state));
    // a's draft gets b as its parent: a -> b -> a.
    const details = await refusal(
      checks({ uid: PAGE, action: "update", params: { documentId: "a" } }, async () => {
        state.parent.push({ child: 1, parent: 3 });
        return { documentId: "a" };
      }),
    );
    expect(details).toEqual({ keys: ["parent"], codes: { parent: "parentCycle" } });
  });

  it("passes a diamond, a resubmitted parent and the repair of a legacy loop", async () => {
    const state = world();
    // A legacy loop c <-> b's draft... c -> a and a -> c on the draft rows.
    state.parent.push({ child: 5, parent: 1 }, { child: 1, parent: 5 });
    const checks = createWikiChecks(fakeHost(state));
    // A title-only save of a (its parent link rewritten to the same document).
    await expect(
      checks({ uid: PAGE, action: "update", params: { documentId: "a" } }, async () => {
        const link = state.parent.find((row) => row.child === 1);
        if (link) link.parent = 5;
        return { documentId: "a" };
      }),
    ).resolves.toEqual({ documentId: "a" });
    // The repair: a's parent cleared.
    await expect(
      checks({ uid: PAGE, action: "update", params: { documentId: "a" } }, async () => {
        state.parent = state.parent.filter((row) => row.child !== 1);
        return { documentId: "a" };
      }),
    ).resolves.toEqual({ documentId: "a" });
    // A diamond: c's published row (new) under b while its draft is under a.
    state.pages.push({ id: 6, documentId: "c", publishedAt: "2026-01-02" });
    await expect(
      checks({ uid: PAGE, action: "publish", params: { documentId: "c" } }, async () => {
        state.parent.push({ child: 6, parent: 4 });
        return { documentId: "c" };
      }),
    ).resolves.toEqual({ documentId: "c" });
  });

  it("refuses a create or update that names a space the draft ends up without", async () => {
    const state = world();
    const checks = createWikiChecks(fakeHost(state));
    state.pages.push({ id: 7, documentId: "new", publishedAt: null });
    const details = await refusal(
      checks(
        {
          uid: PAGE,
          action: "create",
          params: { data: { title: "x", space: { set: [{ documentId: "gone" }] } } },
        },
        async () => ({ documentId: "new" }),
      ),
    );
    expect(details).toEqual({ keys: ["space"] });
    // Linked: fine. Without a space in the payload: not checked.
    state.space.push({ page: 7, space: 10 });
    await expect(
      checks({ uid: PAGE, action: "create", params: { data: { space: "s1" } } }, async () => ({
        documentId: "new",
      })),
    ).resolves.toEqual({ documentId: "new" });
  });

  it("maps a space deleted while the write waited for the lock to invalid on space (staging rehearsal)", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    // Strapi's own lookup of a missing target answers a 400 without keys.
    const next = vi.fn(async () => {
      throw new errors.ValidationError('Document with id "gone", locale "null" not found');
    });
    for (const space of ["gone", { documentId: "gone" }, { id: 99 }, { connect: ["gone"] }]) {
      for (const action of ["create", "update", "clone"]) {
        const details = await refusal(
          checks(
            { uid: PAGE, action, params: { documentId: "c", data: { title: "x", space } } },
            next,
          ),
        );
        expect(details, `${action} ${JSON.stringify(space)}`).toEqual({ keys: ["space"] });
      }
    }
    expect(next).not.toHaveBeenCalled();
    // A space that exists, by documentId or row id, goes on to the action.
    const passed = vi.fn(async () => ({ documentId: "c" }));
    for (const space of ["s1", { id: 10 }]) {
      await checks(
        { uid: PAGE, action: "update", params: { documentId: "c", data: { space } } },
        passed,
      );
    }
    expect(passed).toHaveBeenCalledTimes(2);
  });

  it("refuses a space delete, unpublish and deleting discard while a page links it", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    for (const action of ["delete", "unpublish"]) {
      const details = await refusal(
        checks({ uid: SPACE, action, params: { documentId: "s1" } }, async () => {
          events.push("action");
          return null;
        }),
      );
      expect(details, action).toEqual({ keys: ["_form"], codes: { _form: "spaceNotEmpty" } });
    }
    expect(events).not.toContain("action");
    // The published row exists: a discard rebuilds the draft under the lock;
    // it passes while every page row keeps its space link.
    events.length = 0;
    await checks({ uid: SPACE, action: "discardDraft", params: { documentId: "s1" } }, async () => {
      events.push("action");
      return null;
    });
    expect(events).toEqual(["lock", "action"]);
  });

  it("refuses a space discard that takes a draft-only page out of the space (Codex review)", async () => {
    const state = world();
    const checks = createWikiChecks(fakeHost(state));
    // Strapi 5.57 rebuilds the space's draft row and re-links only pages
    // with a published version: the draft-only page c (row 5) loses its link.
    const details = await refusal(
      checks({ uid: SPACE, action: "discardDraft", params: { documentId: "s1" } }, async () => {
        state.space = state.space.filter((link) => link.page !== 5);
        return null;
      }),
    );
    expect(details).toEqual({ keys: ["_form"], codes: { _form: "spaceNotEmpty" } });
  });

  it("lets an empty space go, under the lock", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    for (const [action, documentId] of [
      ["delete", "s-empty"],
      ["discardDraft", "s-draft-only"],
    ]) {
      events.length = 0;
      await checks({ uid: SPACE, action, params: { documentId } }, async () => {
        events.push("action");
        return null;
      });
      expect(events, action).toEqual(["lock", "action"]);
    }
  });

  it("refuses the slugs the web's routes use as words, from any writer", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    for (const [uid, action, slug] of [
      [PAGE, "create", "new"],
      [PAGE, "update", " New "],
      [PAGE, "clone", "new"],
      [SPACE, "create", "drafts"],
      [SPACE, "update", "DRAFTS"],
    ] as const) {
      events.length = 0;
      const details = await refusal(
        checks({ uid, action, params: { documentId: "a", data: { slug } } }, async () => {
          events.push("action");
          return { documentId: "a" };
        }),
      );
      expect(details, `${uid} ${action}`).toEqual({ keys: ["slug"] });
      expect(events).not.toContain("action");
    }
    // Other words, and the other type's reserved word, pass.
    await expect(
      checks(
        { uid: SPACE, action: "update", params: { documentId: "s1", data: { slug: "new" } } },
        async () => null,
      ),
    ).resolves.toBeNull();
  });

  it("serialises a space's saves and publishes with the page writes, no emptiness check (Codex re-review)", async () => {
    // A publish re-creates the published row from the page links it loaded
    // before deleting the old one: no page write may run in between.
    const checks = createWikiChecks(fakeHost(world()));
    for (const action of ["create", "update", "clone", "publish"]) {
      events.length = 0;
      await checks(
        { uid: SPACE, action, params: { documentId: "s1", status: "published" } },
        async () => {
          events.push("action");
          return null;
        },
      );
      expect(events, action).toEqual(["lock", "action"]);
    }
  });

  it("leaves other types and the reads alone", async () => {
    const checks = createWikiChecks(fakeHost(world()));
    for (const [uid, action] of [
      [SPACE, "findMany"],
      [SPACE, "findOne"],
      ["api::document.document", "delete"],
    ]) {
      events.length = 0;
      await checks({ uid, action, params: { documentId: "s1" } }, async () => {
        events.push("action");
        return null;
      });
      expect(events, `${uid} ${action}`).toEqual(["action"]);
    }
  });
});
