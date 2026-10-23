import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import {
  RSVP_RETENTION_DAYS,
  pruneRsvps,
  rsvpsExpired,
  type RsvpJanitorStrapi,
} from "./prune-rsvps";

/**
 * RSVPs (v0.28, plan rev3 R6): 180 days after the event ended, judged over
 * every surviving row of the event, or once the event is gone. The lock
 * path (an existing event) and the cascade run on both engines in
 * integration/retention-v028.integration.test.ts; this file covers the rule
 * and the gone path, which takes no lock.
 */

const RSVP = "api::event-rsvp.event-rsvp";
const EVENT = "api::event.event";
const NOW = new Date("2026-11-01T02:54:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe("rsvpsExpired (pure)", () => {
  it("is 180 days after the end, or the start without an end", () => {
    expect(RSVP_RETENTION_DAYS).toBe(180);
    expect(rsvpsExpired([{ start: daysAgo(400), end: daysAgo(180.01) }], NOW)).toBe(true);
    expect(rsvpsExpired([{ start: daysAgo(400), end: daysAgo(180) }], NOW)).toBe(false);
    expect(rsvpsExpired([{ start: daysAgo(200), end: null }], NOW)).toBe(true);
    expect(rsvpsExpired([{ start: daysAgo(200), end: "" }], NOW)).toBe(true);
    expect(rsvpsExpired([{ start: daysAgo(100) }], NOW)).toBe(false);
  });

  it("judges every row: an old draft does not end an upcoming published event, nor the reverse", () => {
    const old = { start: daysAgo(300), end: daysAgo(299) };
    const upcoming = { start: daysAgo(-10), end: daysAgo(-11) };
    expect(rsvpsExpired([old, upcoming], NOW)).toBe(false);
    expect(rsvpsExpired([upcoming, old], NOW)).toBe(false);
    expect(rsvpsExpired([old, old], NOW)).toBe(true);
  });

  it("keeps the answers when a date cannot be read; a set but unreadable end never falls back to start", () => {
    for (const row of [
      { start: daysAgo(400), end: "soon" },
      { start: "long ago" },
      { start: null },
      { start: 12345 },
      {},
    ]) {
      expect(rsvpsExpired([row], NOW), JSON.stringify(row)).toBe(false);
    }
  });

  it("an event without any row is gone: its answers go", () => {
    expect(rsvpsExpired([], NOW)).toBe(true);
  });
});

describe("pruneRsvps, events gone in every state", () => {
  it("deletes the RSVPs of gone events only, logs once, and finds nothing the next night", async () => {
    const strapi = createStrapiStub({
      tables: {
        [RSVP]: [
          { id: 1, targetDocumentId: "gone1", status: "yes" },
          { id: 2, targetDocumentId: "live1", status: "no" },
          { id: 3, targetDocumentId: "gone1", status: "maybe" },
          { id: 4, targetDocumentId: "gone2", status: "yes" },
        ],
        [EVENT]: [
          // Upcoming: its answers stay (and the lock path is never entered).
          { id: 10, documentId: "live1", start: daysAgo(-5), end: null, publishedAt: null },
        ],
      },
    });
    await expect(pruneRsvps(strapi as unknown as RsvpJanitorStrapi, NOW)).resolves.toBe(3);
    expect(strapi.tables[RSVP].map((row) => row.id)).toEqual([2]);
    expect(strapi.log.info.mock.calls).toEqual([
      [
        "[rsvp-janitor] pruned 3 RSVP(s) of events that ended more than 180 days ago or no longer exist",
      ],
    ]);
    strapi.log.info.mockClear();
    await expect(pruneRsvps(strapi as unknown as RsvpJanitorStrapi, NOW)).resolves.toBe(0);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });
});
