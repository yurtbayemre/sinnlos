import { describe, expect, it, vi } from "vitest";

import { deleteAuditContext } from "./delete-audit";
import {
  TOMBSTONE_RETRY_MS,
  claimAndRemove,
  claimDecision,
  classifiedImageFileIds,
  isReservedRemoval,
  isTombstoned,
  linkedFileIds,
  mediaReferences,
  reserveRemoval,
  resolveFileIds,
  tombstoneOf,
} from "./upload-orphans";

/**
 * The one reservation every removal takes (decision 06 §E3-§E5; batch 16
 * plan item 4, contract K12; Codex round 1): the decision under the lock,
 * the tombstone and the audit row committed before the bytes go, one
 * removal per file, and every raw read on the caller's transaction.
 */

const NOW = new Date("2026-10-13T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const stamped = (extra: Record<string, unknown> = {}) => ({
  id: 5,
  documentId: "f5",
  name: "a.pdf",
  createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
  provider_metadata: { uploadedBy: 7, ...extra },
});

describe("claimDecision (the app's rules under the lock)", () => {
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

  it("retrying a stale reservation re-checks only the links", () => {
    const admins = { id: 5, provider_metadata: { removing: "2026-10-13T00:00:00Z" } };
    expect(claimDecision(admins, false, { ownerId: 8, minAgeMs: DAY }, NOW, true)).toBe("claim");
    expect(claimDecision(admins, true, {}, NOW, true)).toBe("linked");
  });

  it("reads a tombstone; an unparseable one counts as old", () => {
    expect(isTombstoned(stamped())).toBe(false);
    expect(tombstoneOf(stamped({ removing: "2026-10-13T09:00:00.000Z" }))?.toISOString()).toBe(
      "2026-10-13T09:00:00.000Z",
    );
    expect(tombstoneOf(stamped({ removing: "x" }))?.getTime()).toBe(0);
  });
});

describe("mediaReferences / resolveFileIds (every shape Strapi 5.57 accepts)", () => {
  it("reads ids, documentIds, { id }, { documentId }, lists and connect/set", () => {
    expect(mediaReferences(7)).toEqual({ ids: [7], documentIds: [] });
    expect(mediaReferences("8")).toEqual({ ids: [8], documentIds: [] });
    expect(mediaReferences("abc123")).toEqual({ ids: [], documentIds: ["abc123"] });
    expect(mediaReferences({ connect: [{ id: 2 }, { documentId: "d2" }], set: [3] })).toEqual({
      ids: [2, 3],
      documentIds: ["d2"],
    });
    expect(mediaReferences([{ id: "4" }, null, { other: 1 }])).toEqual({
      ids: [4],
      documentIds: [],
    });
    expect(mediaReferences(null)).toEqual({ ids: [], documentIds: [] });
    expect(mediaReferences(2 ** 40)).toEqual({ ids: [], documentIds: [] });
  });

  it("reads the strings Strapi coerces to a row id as that id too (Codex round 3)", () => {
    for (const raw of [" 1", "+1", "1.0", "1 "]) {
      expect(mediaReferences(raw).ids, JSON.stringify(raw)).toEqual([1]);
    }
    expect(mediaReferences({ set: [{ id: " 2" }] }).ids).toEqual([2]);
    expect(mediaReferences(" ")).toEqual({ ids: [], documentIds: [" "] });
    expect(mediaReferences("1.5").ids).toEqual([]);
  });

  it("resolves documentIds to row ids, ascending, dropping unknown ones", async () => {
    const strapi = {
      db: {
        query: () => ({
          findMany: async ({ where }: { where: { documentId: { $in: string[] } } }) =>
            where.documentId.$in.includes("d9") ? [{ id: 9 }] : [],
        }),
      },
    };
    expect(await resolveFileIds(strapi, { ids: [12, 3], documentIds: ["d9", "gone"] })).toEqual([
      3, 9, 12,
    ]);
  });
});

/** A fake strapi.db: one file row, its links, the lock, the audit table and the transaction log. */
function makeStrapi(opts: {
  file: Record<string, any> | null;
  linked?: boolean;
  removeFails?: boolean;
  auditFails?: boolean;
}) {
  const log: string[] = [];
  const audit: Array<Record<string, unknown>> = [];
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
      select: async () => (opts.linked ? [{ related_type: "api::x.x", related_id: 1 }] : []),
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
        const before = file;
        try {
          const result = await cb({ trx: "trx1" });
          log.push("commit");
          return result;
        } catch (err) {
          file = before;
          log.push("rollback");
          throw err;
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
      query: (uid: string) => ({
        findOne: async () => file,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          log.push("tombstone");
          file = { ...file, ...data };
          return file;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          expect(uid).toBe("api::audit-event.audit-event");
          if (opts.auditFails) throw new Error("audit insert failed");
          log.push("audit");
          audit.push(data);
          return data;
        },
      }),
    },
    requestContext: { get: () => undefined },
    plugin: () => ({
      service: () => ({
        remove: async (row: any) => {
          log.push(`remove:${row.provider_metadata?.removing ? "tombstoned" : "live"}`);
          log.push(`reserved:${isReservedRemoval(row.id)}`);
          log.push(`context:${JSON.stringify(deleteAuditContext() ?? null)}`);
          if (opts.removeFails) throw new Error("row delete failed after the bytes");
          file = null;
        },
      }),
    }),
  };
  return { strapi, log, audit, current: () => file };
}

describe("reserveRemoval", () => {
  it("locks, re-reads, writes the tombstone and the audit row in one transaction", async () => {
    const { strapi, log, audit, current } = makeStrapi({ file: stamped() });
    const reserved = await reserveRemoval(strapi, 5, undefined, NOW);
    expect("file" in reserved).toBe(true);
    expect(log).toEqual(["begin", "lock", "links:trx1", "tombstone", "audit", "commit"]);
    expect(isTombstoned(current())).toBe(true);
    expect(audit).toEqual([expect.objectContaining({ action: "delete", targetDocumentId: "f5" })]);
  });

  it("skips a missing file and a fresh reservation: overlapping deletes record once", async () => {
    expect(await reserveRemoval(makeStrapi({ file: null }).strapi, 5, undefined, NOW)).toEqual({
      outcome: "missing",
    });
    const { strapi, audit } = makeStrapi({ file: stamped() });
    await reserveRemoval(strapi, 5, undefined, NOW);
    expect(await reserveRemoval(strapi, 5, undefined, NOW)).toEqual({ outcome: "removing" });
    expect(audit).toHaveLength(1);
  });

  it("takes over a stale reservation without a second audit row", async () => {
    const stale = stamped({ removing: new Date(NOW.getTime() - TOMBSTONE_RETRY_MS).toISOString() });
    const { strapi, audit, current } = makeStrapi({ file: stale });
    expect("file" in (await reserveRemoval(strapi, 5, undefined, NOW))).toBe(true);
    expect(audit).toEqual([]);
    expect(tombstoneOf(current())?.getTime()).toBe(NOW.getTime());
  });

  it("writes nothing when the audit insert fails", async () => {
    const { strapi, current, log } = makeStrapi({ file: stamped(), auditFails: true });
    await expect(reserveRemoval(strapi, 5, undefined, NOW)).rejects.toThrow("audit insert failed");
    expect(isTombstoned(current())).toBe(false);
    expect(log).toContain("rollback");
  });
});

describe("claimAndRemove", () => {
  it("reserves under the app's rules, and only then removes, inside its reservation", async () => {
    const { strapi, log } = makeStrapi({ file: stamped() });
    expect(
      await claimAndRemove(strapi, 5, { now: NOW, related: { uid: "api::x.x", documentId: "d1" } }),
    ).toBe("removed");
    expect(log).toEqual([
      "begin",
      "lock",
      "links:trx1",
      "tombstone",
      "audit",
      "commit",
      "remove:tombstoned",
      "reserved:true",
      'context:{"related":{"uid":"api::x.x","documentId":"d1"}}',
    ]);
  });

  it("removes and records nothing when the re-check fails under the lock", async () => {
    const linked = makeStrapi({ file: stamped(), linked: true });
    expect(await claimAndRemove(linked.strapi, 5, { now: NOW })).toBe("linked");
    expect(linked.log).not.toContain("tombstone");
    expect(linked.audit).toEqual([]);
    const foreign = makeStrapi({ file: stamped() });
    expect(await claimAndRemove(foreign.strapi, 5, { ownerId: 99, now: NOW })).toBe("foreign");
    const unstamped = makeStrapi({ file: { id: 5, provider_metadata: null } });
    expect(await claimAndRemove(unstamped.strapi, 5, { now: NOW })).toBe("unstamped");
    expect(unstamped.log.some((line) => line.startsWith("remove"))).toBe(false);
  });

  it("a failure after the reservation leaves a tombstoned row; a later retry completes it once", async () => {
    const { strapi, current, audit } = makeStrapi({ file: stamped(), removeFails: true });
    expect(await claimAndRemove(strapi, 5, { now: NOW })).toBe("failed");
    expect(isTombstoned(current())).toBe(true);
    expect(audit).toHaveLength(1);
    expect(strapi.log.error).toHaveBeenCalledWith(expect.stringContaining("tombstoned"));
    // Another remover skips it within the window; afterwards it completes it.
    const retry = makeStrapi({ file: current() });
    expect(await claimAndRemove(retry.strapi, 5, { now: NOW })).toBe("removing");
    const later = new Date(NOW.getTime() + TOMBSTONE_RETRY_MS);
    expect(await claimAndRemove(retry.strapi, 5, { now: later, minAgeMs: DAY })).toBe("removed");
    expect(retry.audit).toEqual([]);
  });

  it("refuses to run inside a transaction (its reservation must commit on its own)", async () => {
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
