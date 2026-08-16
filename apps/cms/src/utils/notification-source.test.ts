import { describe, expect, it } from "vitest";
import {
  notifiedRecipientIds,
  planFanout,
  resolveFanout,
  sourceAnchor,
  sourceFilter,
  type NotificationSourceType,
  type SourceAnchor,
} from "./notification-source";

/**
 * The dedup half of the notification fan-out (GitHub issue #12).
 *
 * Publishing a draftAndPublish entry in Strapi 5 is delete-then-recreate, so
 * every re-publish fired `afterCreate` again and the whole audience got the
 * same notification a second, third, … time. The dedup is per (source
 * document, RECIPIENT) — these tests pin what that buys:
 *   1. first publish notifies the whole audience,
 *   2. a re-publish with an unchanged audience notifies nobody,
 *   3. RETARGETING works: re-publishing to a changed audience notifies the
 *      newly targeted users and nobody twice (the source-granular first cut
 *      of #12 left them permanently unreachable),
 *   4. a fan-out aborted after k of n rows HEALS on the next publish — the
 *      reason no transaction bracket is needed,
 *   5. different sources (and identical documentIds across content types)
 *      never suppress each other,
 *   6. legacy rows without an anchor stay invisible to the dedup — the
 *      documented one-time re-notify for the 106 pre-existing notifications,
 *   7. everything unknown fails OPEN (no documentId, failed lookup, id-less
 *      audience member → notify) instead of silently swallowing messages.
 *
 * The runtime wrapper only touches `strapi.db.query(…).findMany` and
 * `strapi.log`, so a small stub is enough — no Strapi runtime, no database.
 */

const ANNOUNCEMENT_DOC = "a1b2c3d4e5f6g7h8i9j0kl";
const OTHER_ANNOUNCEMENT_DOC = "z9y8x7w6v5u4t3s2r1q0po";

interface StoredNotification {
  sourceType?: string | null;
  sourceDocumentId?: string | null;
  recipient?: { id: number } | null;
}

/** An audience member as the lifecycles hand it over. */
const user = (id: number) => ({ id });
const userId = (member: { id?: unknown }) => member.id;

/**
 * Stub of the notification table. `findMany` mirrors the db-layer semantics
 * we rely on: an exact match on both scalar columns (NULL never equals a
 * value — that is what makes legacy rows invisible), and `recipient` only
 * present because the caller populates it.
 */
function stubStrapi(rows: StoredNotification[], onQuery?: () => never) {
  const logs: { level: string; message: string }[] = [];
  const calls: Record<string, unknown>[] = [];
  return {
    logs,
    calls,
    db: {
      query: (uid: string) => {
        if (uid !== "api::notification.notification") {
          throw new Error(`unexpected uid ${uid}`);
        }
        return {
          findMany: async (params: {
            where: Record<string, unknown>;
            populate: Record<string, unknown>;
          }) => {
            calls.push(params);
            onQuery?.();
            return rows
              .filter(
                (row) =>
                  row.sourceType === params.where.sourceType &&
                  row.sourceDocumentId === params.where.sourceDocumentId,
              )
              .map((row) => ({ recipient: row.recipient ?? null }));
          },
        };
      },
    },
    log: {
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
    },
  };
}

/** One notification as the lifecycles write it. */
const notified = (
  sourceType: NotificationSourceType,
  sourceDocumentId: string,
  recipientId: number,
): StoredNotification => ({ sourceType, sourceDocumentId, recipient: { id: recipientId } });

/** A pre-#12 notification: title/link only, no back-reference. */
const legacy = (recipientId: number): StoredNotification => ({
  sourceType: null,
  sourceDocumentId: null,
  recipient: { id: recipientId },
});

describe("sourceAnchor", () => {
  it("anchors on the documentId, not the numeric row id", () => {
    expect(sourceAnchor("announcement", { id: 42, documentId: ANNOUNCEMENT_DOC })).toEqual({
      sourceType: "announcement",
      sourceDocumentId: ANNOUNCEMENT_DOC,
    });
  });

  it("returns null when the row carries no usable documentId", () => {
    expect(sourceAnchor("announcement", { id: 42 })).toBeNull();
    expect(sourceAnchor("announcement", { id: 42, documentId: null })).toBeNull();
    expect(sourceAnchor("announcement", { id: 42, documentId: "   " })).toBeNull();
    expect(sourceAnchor("event", null)).toBeNull();
    expect(sourceAnchor("event", undefined)).toBeNull();
  });

  it("builds a where filter over both anchor columns", () => {
    const anchor = sourceAnchor("event", { documentId: ANNOUNCEMENT_DOC }) as SourceAnchor;
    expect(sourceFilter(anchor)).toEqual({
      sourceType: "event",
      sourceDocumentId: ANNOUNCEMENT_DOC,
    });
  });
});

describe("notifiedRecipientIds", () => {
  it("collects the recipient ids of the anchored notifications", () => {
    expect(
      notifiedRecipientIds([
        { recipient: { id: 1 } },
        { recipient: { id: 2 } },
        // Same user twice (an earlier race, §7b/#16) is one entry.
        { recipient: { id: 2 } },
      ]),
    ).toEqual(new Set(["1", "2"]));
  });

  it("ignores rows whose recipient is missing — they suppress nobody", () => {
    expect(notifiedRecipientIds([{ recipient: null }, {}, { recipient: { id: null } }])).toEqual(
      new Set(),
    );
  });

  it("returns null (= unknown, fail open) when the result is not a row list", () => {
    expect(notifiedRecipientIds(undefined)).toBeNull();
    expect(notifiedRecipientIds(null)).toBeNull();
    expect(notifiedRecipientIds({ count: 3 })).toBeNull();
  });
});

describe("planFanout", () => {
  const anchor: SourceAnchor = {
    sourceType: "announcement",
    sourceDocumentId: ANNOUNCEMENT_DOC,
  };

  it("notifies the whole audience on the first publish", () => {
    const audience = [user(1), user(2), user(3)];
    expect(planFanout(anchor, [], audience, userId)).toEqual({
      recipients: audience,
      audienceSize: 3,
      alreadyNotified: 0,
      reason: "first-publish",
    });
  });

  it("notifies nobody when every current recipient already holds a row", () => {
    const plan = planFanout(anchor, [1, 2], [user(1), user(2)], userId);
    expect(plan.recipients).toEqual([]);
    expect(plan).toMatchObject({ audienceSize: 2, alreadyNotified: 2, reason: "already-notified" });
  });

  it("notifies the RETARGETED audience without re-notifying the old one", () => {
    // Published to department A (users 1,2), corrected to department B
    // (users 3,4) — plus user 2, who is in both.
    const plan = planFanout(anchor, [1, 2], [user(2), user(3), user(4)], userId);
    expect(plan.recipients).toEqual([user(3), user(4)]);
    expect(plan).toMatchObject({ audienceSize: 3, alreadyNotified: 1, reason: "partial-fanout" });
  });

  it("heals a fan-out that died after k of n rows", () => {
    // The write loop crashed after users 1 and 2; the next publish sees them
    // anchored and delivers exactly the missing 3,4,5 — no transaction needed.
    const plan = planFanout(anchor, [1, 2], [user(1), user(2), user(3), user(4), user(5)], userId);
    expect(plan.recipients).toEqual([user(3), user(4), user(5)]);
    expect(plan).toMatchObject({ audienceSize: 5, alreadyNotified: 2, reason: "partial-fanout" });
  });

  it("matches ids across the number/string divide", () => {
    const plan = planFanout(anchor, ["1", 2], [user(1), user(2), user(3)], userId);
    expect(plan.recipients).toEqual([user(3)]);
  });

  it("reports an empty audience instead of pretending everyone was notified", () => {
    expect(planFanout(anchor, [1, 2], [], userId)).toEqual({
      recipients: [],
      audienceSize: 0,
      alreadyNotified: 0,
      reason: "empty-audience",
    });
    expect(planFanout(anchor, [], undefined, userId).reason).toBe("empty-audience");
  });

  it("fails open when the already-notified set could not be loaded", () => {
    const audience = [user(1), user(2)];
    expect(planFanout(anchor, null, audience, userId)).toEqual({
      recipients: audience,
      audienceSize: 2,
      alreadyNotified: 0,
      reason: "lookup-failed",
    });
    expect(planFanout(anchor, undefined, audience, userId).reason).toBe("lookup-failed");
  });

  it("fails open when the source has no anchor at all", () => {
    const audience = [user(1), user(2)];
    // Even a non-empty notified set cannot belong to an unknown source.
    expect(planFanout(null, [1, 2], audience, userId)).toEqual({
      recipients: audience,
      audienceSize: 2,
      alreadyNotified: 0,
      reason: "no-anchor",
    });
  });

  it("fails open for an audience member without a usable id", () => {
    // Cannot be matched against the notified set → notify rather than drop.
    const audience: { id: number | null }[] = [{ id: 1 }, { id: null }];
    expect(planFanout(anchor, [1], audience, userId).recipients).toEqual([{ id: null }]);
  });
});

describe("resolveFanout", () => {
  it("notifies the whole audience on the first publish and hands back the anchor", async () => {
    const strapi = stubStrapi([]);
    const audience = [user(1), user(2)];
    const { recipients, anchor } = await resolveFanout(
      strapi,
      "announcement",
      { id: 7, documentId: ANNOUNCEMENT_DOC },
      audience,
      userId,
    );

    expect(recipients).toEqual(audience);
    expect(anchor).toEqual({
      sourceType: "announcement",
      sourceDocumentId: ANNOUNCEMENT_DOC,
    });
    // ONE query, filtered on both anchor columns, recipient id populated.
    expect(strapi.calls).toEqual([
      {
        where: { sourceType: "announcement", sourceDocumentId: ANNOUNCEMENT_DOC },
        populate: { recipient: { select: ["id"] } },
      },
    ]);
    expect(strapi.logs).toEqual([]);
  });

  it("notifies nobody on a re-publish with an unchanged audience, and logs why", async () => {
    // Publish #2: the row id changed (delete+recreate), the documentId did not.
    const strapi = stubStrapi([
      notified("announcement", ANNOUNCEMENT_DOC, 1),
      notified("announcement", ANNOUNCEMENT_DOC, 2),
    ]);
    const { recipients } = await resolveFanout(
      strapi,
      "announcement",
      { id: 99, documentId: ANNOUNCEMENT_DOC },
      [user(1), user(2)],
      userId,
    );

    expect(recipients).toEqual([]);
    const info = strapi.logs.filter((entry) => entry.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain(ANNOUNCEMENT_DOC);
    expect(info[0].message).toContain("2 of 2 recipient(s) already notified, 0 new");
  });

  it("delivers to a retargeted audience and logs the split", async () => {
    // Announcement went to department A (users 1,2), was corrected to
    // department B (users 3,4) and published again.
    const strapi = stubStrapi([
      notified("announcement", ANNOUNCEMENT_DOC, 1),
      notified("announcement", ANNOUNCEMENT_DOC, 2),
    ]);
    const { recipients } = await resolveFanout(
      strapi,
      "announcement",
      { id: 100, documentId: ANNOUNCEMENT_DOC },
      [user(2), user(3), user(4)],
      userId,
    );

    expect(recipients).toEqual([user(3), user(4)]);
    const info = strapi.logs.filter((entry) => entry.level === "info");
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain("1 of 3 recipient(s) already notified, 2 new");
  });

  it("does not let one source suppress another", async () => {
    const strapi = stubStrapi([notified("announcement", ANNOUNCEMENT_DOC, 1)]);
    const audience = [user(1), user(2)];

    // A different announcement.
    expect(
      (
        await resolveFanout(
          strapi,
          "announcement",
          { id: 8, documentId: OTHER_ANNOUNCEMENT_DOC },
          audience,
          userId,
        )
      ).recipients,
    ).toEqual(audience);

    // Same documentId, different content type: documentIds are unique per
    // collection, so sourceType has to be part of the key.
    expect(
      (
        await resolveFanout(
          strapi,
          "event",
          { id: 3, documentId: ANNOUNCEMENT_DOC },
          audience,
          userId,
        )
      ).recipients,
    ).toEqual(audience);
  });

  it("ignores legacy notifications without a source reference (one-time re-notify)", async () => {
    // The 106 pre-#12 rows: same audience, same titles, but no anchor.
    const strapi = stubStrapi([legacy(1), legacy(2), legacy(3)]);
    const audience = [user(1), user(2), user(3)];
    const { recipients } = await resolveFanout(
      strapi,
      "announcement",
      { id: 12, documentId: ANNOUNCEMENT_DOC },
      audience,
      userId,
    );

    // Documented consequence: this one publish notifies again …
    expect(recipients).toEqual(audience);

    // … and writes the anchor, so the publish after it notifies nobody.
    const afterBackfillByPublish = stubStrapi([
      legacy(1),
      notified("announcement", ANNOUNCEMENT_DOC, 1),
      notified("announcement", ANNOUNCEMENT_DOC, 2),
      notified("announcement", ANNOUNCEMENT_DOC, 3),
    ]);
    expect(
      (
        await resolveFanout(
          afterBackfillByPublish,
          "announcement",
          { id: 13, documentId: ANNOUNCEMENT_DOC },
          audience,
          userId,
        )
      ).recipients,
    ).toEqual([]);
  });

  it("notifies without dedup (and warns) when the source has no documentId", async () => {
    const strapi = stubStrapi([notified("announcement", ANNOUNCEMENT_DOC, 1)]);
    const audience = [user(1), user(2)];
    const { recipients, anchor } = await resolveFanout(
      strapi,
      "announcement",
      { id: 5 },
      audience,
      userId,
    );

    expect(recipients).toEqual(audience);
    expect(anchor).toBeNull();
    // No key to filter on — the DB must not be queried with a null anchor.
    expect(strapi.calls).toEqual([]);
    expect(strapi.logs.filter((entry) => entry.level === "warn")).toHaveLength(1);
  });

  it("notifies everybody (and warns) when the lookup itself fails", async () => {
    const strapi = stubStrapi([notified("announcement", ANNOUNCEMENT_DOC, 1)], () => {
      throw new Error("connection terminated");
    });
    const audience = [user(1), user(2)];
    const { recipients } = await resolveFanout(
      strapi,
      "announcement",
      { id: 6, documentId: ANNOUNCEMENT_DOC },
      audience,
      userId,
    );

    // A duplicate is annoying, a missing announcement is a broken feature.
    expect(recipients).toEqual(audience);
    const warn = strapi.logs.filter((entry) => entry.level === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0].message).toContain("connection terminated");
  });

  it("stays quiet when there is simply nobody to notify", async () => {
    const strapi = stubStrapi([]);
    const { recipients } = await resolveFanout(
      strapi,
      "event",
      { id: 4, documentId: ANNOUNCEMENT_DOC },
      [],
      userId,
    );

    expect(recipients).toEqual([]);
    expect(strapi.logs).toEqual([]);
  });
});
