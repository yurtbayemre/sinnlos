/**
 * Delete-lifecycle transaction timing (review fix K2).
 *
 * No DB here — a fake `strapi` models the one thing that matters: afterDelete
 * must NOT run its orphan re-check + removal inline (it would see the
 * not-yet-committed deleteRelations rows under READ COMMITTED and skip
 * everything), but must defer them to `onCommit`, i.e. after the transaction
 * commits. We drive the deferral explicitly: registered callbacks do not run
 * until the test "commits", and only then is the file removed — and only when
 * it is both stamped and unattached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import lifecycles from "./lifecycles";

type FakeFile = { id: number; provider?: string; provider_metadata?: unknown };

function makeStrapi(opts: { files: FakeFile[]; attachedFileIds: number[] }) {
  const commitCallbacks: Array<() => unknown> = [];
  const removed: number[] = [];
  const strapi = {
    log: { info: vi.fn(), error: vi.fn() },
    plugin: () => ({
      service: () => ({
        remove: async (file: FakeFile) => {
          removed.push(file.id);
        },
      }),
    }),
    db: {
      // Nested transaction: register onCommit callbacks, do NOT run them yet.
      transaction: (cb: (args: { onCommit: (fn: () => unknown) => void }) => void) => {
        cb({ onCommit: (fn) => commitCallbacks.push(fn) });
        return Promise.resolve();
      },
      getConnection: () => ({
        whereIn: () => ({ pluck: async () => opts.attachedFileIds }),
      }),
      query: () => ({
        findOne: async ({ where }: { where: { id: number } }) =>
          opts.files.find((f) => f.id === where.id) ?? null,
      }),
    },
  };
  return { strapi, commitCallbacks, removed };
}

async function runCommit(callbacks: Array<() => unknown>) {
  for (const cb of callbacks) await cb();
}

describe("classified afterDelete cleanup (K2 — post-commit deferral)", () => {
  let restore: unknown;

  beforeEach(() => {
    restore = (globalThis as any).strapi;
  });
  afterEach(() => {
    (globalThis as any).strapi = restore;
  });

  it("does NOT remove inline — only after the transaction commits", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: { uploadedBy: 7 } }],
      attachedFileIds: [],
    });
    (globalThis as any).strapi = strapi;

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    // Deferred: nothing removed yet, exactly one onCommit callback queued.
    expect(removed).toEqual([]);
    expect(commitCallbacks).toHaveLength(1);

    await runCommit(commitCallbacks);
    expect(removed).toEqual([10]);
  });

  it("skips a file that is still attached to another ad", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: { uploadedBy: 7 } }],
      attachedFileIds: [10],
    });
    (globalThis as any).strapi = strapi;

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    await runCommit(commitCallbacks);
    expect(removed).toEqual([]);
  });

  it("never touches an unstamped (admin) upload", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: null }],
      attachedFileIds: [],
    });
    (globalThis as any).strapi = strapi;

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    await runCommit(commitCallbacks);
    expect(removed).toEqual([]);
  });

  it("no recorded ids → no transaction, no removal", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [],
      attachedFileIds: [],
    });
    (globalThis as any).strapi = strapi;

    await lifecycles.afterDelete({ state: {} });
    expect(commitCallbacks).toHaveLength(0);
    expect(removed).toEqual([]);
  });
});
