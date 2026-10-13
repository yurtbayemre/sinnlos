import { describe, expect, it, vi } from "vitest";

import { deleteAuditContext } from "./delete-audit";
import {
  TOMBSTONE_RETRY_MS,
  claimAndRemove,
  claimDecision,
  classifiedImageFileIds,
  isTombstoned,
  linkedFileIds,
  tombstoneOf,
} from "./upload-orphans";

/**
 * The one locked removal (decision 06 §E3-§E5; batch 16 plan item 4,
 * contract K12): the decision under the lock, the tombstone committed
 * before the bytes go, and every raw read on the caller's transaction.
 */

const NOW = new Date("2026-10-13T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const stamped = (extra: Record<string, unknown> = {}) => ({
  id: 5,
  createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
  provider_metadata: { uploadedBy: 7, ...extra },
});

describe("claimDecision (under the lock)", () => {
  it("claims a stamped, unlinked file", () => {
    expect(claimDecision(stamped(), false, {}, NOW)).toBe("claim");
  });

  it("refuses missing, unstamped, foreign, linked and young files", () => {
    expect(claimDecision(null, false, {}, NOW)).toBe("missing");
    expect(claimDecision({ id: 5, provider_metadata: null }, false, {}, NOW)).toBe("unstamped");
    expect(claimDecision(stamped(), false, { ownerId: 8 }, NOW)).toBe("foreign");
    expect(claimDecision(stamped(), true, {}, NOW)).toBe("linked");
    const young = { ...stamped(), createdAt: new Date(NOW.getTime() - 1000).toISOString() };
    expect(claimDecision(young, false, { minAgeMs: DAY }, NOW)).toBe("young");
    expect(
      claimDecision({ ...stamped(), createdAt: "garbage" }, false, { minAgeMs: DAY }, NOW),
    ).toBe("young");
  });

  it("skips a tombstoned file unless the caller retries old tombstones", () => {
    const tombstoned = stamped({
      removing: new Date(NOW.getTime() - TOMBSTONE_RETRY_MS).toISOString(),
    });
    expect(claimDecision(tombstoned, false, {}, NOW)).toBe("removing");
    expect(
      claimDecision(tombstoned, false, { retryTombstoneAfterMs: TOMBSTONE_RETRY_MS }, NOW),
    ).toBe("claim");
    expect(
      claimDecision(tombstoned, false, { retryTombstoneAfterMs: TOMBSTONE_RETRY_MS + 1 }, NOW),
    ).toBe("removing");
    // A retried tombstone still re-checks its links.
    expect(claimDecision(tombstoned, true, { retryTombstoneAfterMs: 0 }, NOW)).toBe("linked");
  });

  it("reads a tombstone; an unparseable one counts as old", () => {
    expect(isTombstoned(stamped())).toBe(false);
    expect(tombstoneOf(stamped({ removing: "2026-10-13T09:00:00.000Z" }))?.toISOString()).toBe(
      "2026-10-13T09:00:00.000Z",
    );
    expect(tombstoneOf(stamped({ removing: "x" }))?.getTime()).toBe(0);
  });
});

/** A fake strapi.db: one file table, a link table, the lock and transaction log. */
function makeStrapi(opts: {
  file: Record<string, any> | null;
  linked?: boolean;
  removeFails?: boolean;
}) {
  const log: string[] = [];
  let file = opts.file ? { ...opts.file } : null;
  let open = false;
  const linkBuilder = () => {
    const builder: any = {
      transacting: (trx: unknown) => {
        log.push(`links:${String(trx)}`);
        return builder;
      },
      where: () => builder,
      whereIn: () => builder,
      pluck: async () => (opts.linked ? [5] : []),
    };
    return builder;
  };
  const strapi: any = {
    log: { error: vi.fn() },
    db: {
      inTransaction: () => open,
      transaction: async (cb: (scope: { trx: unknown }) => Promise<unknown>) => {
        open = true;
        log.push("begin");
        try {
          const result = await cb({ trx: "trx1" });
          log.push("commit");
          return result;
        } finally {
          open = false;
        }
      },
      queryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: () => qb,
          forUpdate: () => {
            log.push("lock");
            return qb;
          },
          execute: async () => [],
        };
        return qb;
      },
      getConnection: () => linkBuilder(),
      query: () => ({
        findOne: async () => file,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          log.push("tombstone");
          file = { ...file, ...data };
          return file;
        },
      }),
    },
    plugin: () => ({
      service: () => ({
        remove: async (row: any) => {
          log.push(`remove:${row.provider_metadata?.removing ? "tombstoned" : "live"}`);
          log.push(`context:${JSON.stringify(deleteAuditContext() ?? null)}`);
          if (opts.removeFails) throw new Error("row delete failed after the bytes");
          file = null;
        },
      }),
    }),
  };
  return { strapi, log, current: () => file };
}

describe("claimAndRemove", () => {
  it("locks, re-checks, commits the tombstone, and only then removes", async () => {
    const { strapi, log } = makeStrapi({ file: stamped() });
    expect(
      await claimAndRemove(strapi, 5, { now: NOW, related: { uid: "api::x.x", documentId: "d1" } }),
    ).toBe("removed");
    expect(log).toEqual([
      "begin",
      "lock",
      "links:trx1",
      "tombstone",
      "commit",
      "remove:tombstoned",
      'context:{"related":{"uid":"api::x.x","documentId":"d1"}}',
    ]);
  });

  it("removes nothing when the re-check fails under the lock", async () => {
    const linked = makeStrapi({ file: stamped(), linked: true });
    expect(await claimAndRemove(linked.strapi, 5, { now: NOW })).toBe("linked");
    expect(linked.log).not.toContain("tombstone");
    const foreign = makeStrapi({ file: stamped() });
    expect(await claimAndRemove(foreign.strapi, 5, { ownerId: 99, now: NOW })).toBe("foreign");
    const unstamped = makeStrapi({ file: { id: 5, provider_metadata: null } });
    expect(await claimAndRemove(unstamped.strapi, 5, { now: NOW })).toBe("unstamped");
    expect(unstamped.log.some((line) => line.startsWith("remove"))).toBe(false);
  });

  it("a failure after the claim leaves a tombstoned row, which attaches refuse and the janitor retries", async () => {
    const { strapi, current } = makeStrapi({ file: stamped(), removeFails: true });
    expect(await claimAndRemove(strapi, 5, { now: NOW })).toBe("failed");
    expect(isTombstoned(current())).toBe(true);
    expect(strapi.log.error).toHaveBeenCalledWith(expect.stringContaining("tombstoned"));
    // Another remover skips it; the janitor's retry (after 10 minutes) takes it.
    const later = new Date(NOW.getTime() + TOMBSTONE_RETRY_MS);
    const retry = makeStrapi({ file: current() });
    expect(await claimAndRemove(retry.strapi, 5, { now: later })).toBe("removing");
    expect(
      await claimAndRemove(retry.strapi, 5, {
        now: later,
        retryTombstoneAfterMs: TOMBSTONE_RETRY_MS,
      }),
    ).toBe("removed");
    // The retry keeps the first tombstone (no second write).
    expect(retry.log.filter((line) => line === "tombstone")).toEqual([]);
  });

  it("refuses to run inside a transaction (its claim must commit on its own)", async () => {
    const { strapi } = makeStrapi({ file: stamped() });
    strapi.db.inTransaction = () => true;
    await expect(claimAndRemove(strapi, 5)).rejects.toThrow(/outside a transaction/);
  });
});

describe("raw link reads join the caller's transaction (K12)", () => {
  function linkStrapi(log: string[]) {
    const builder: any = {
      transacting: (trx: unknown) => {
        log.push(`trx:${String(trx)}`);
        return builder;
      },
      where: () => builder,
      whereIn: () => builder,
      pluck: async () => [3, 3, 4],
    };
    return { db: { getConnection: () => builder } };
  }

  it("classifiedImageFileIds and linkedFileIds pass `trx` on", async () => {
    const log: string[] = [];
    expect(await classifiedImageFileIds(linkStrapi(log), [1], "T")).toEqual([3, 4]);
    expect([...(await linkedFileIds(linkStrapi(log), [3, 4], "T"))]).toEqual([3, 4]);
    expect(log).toEqual(["trx:T", "trx:T"]);
    // Outside a transaction (the janitor's pre-filter) the pool is used.
    await linkedFileIds(linkStrapi(log), [3], undefined);
    expect(log).toHaveLength(2);
  });
});
