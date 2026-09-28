/**
 * The shared notification writer (FX18, QW-FX18a).
 *
 * buildNotification is pure: titles never exceed varchar(255) counted in
 * code points (Postgres 22001 aborted the publish transaction before), the
 * fixed text survives the cut, and missing values fall back. The writer and
 * the fan-out run against the shared Strapi stub.
 */
import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import {
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_UID,
  buildNotification,
  buildTitle,
  runSourceFanout,
  writeNotifications,
  type NotificationData,
} from "./notify";

const codePoints = (value: string) => Array.from(value).length;

describe("buildTitle", () => {
  it("joins fixed text and values", () => {
    expect(buildTitle(["New announcement: ", { value: "Town hall", fallback: "Untitled" }])).toBe(
      "New announcement: Town hall",
    );
  });

  it("falls back for a missing, non-string or blank value", () => {
    for (const value of [null, undefined, 42, "", "   "]) {
      expect(buildTitle(["New event: ", { value, fallback: "Untitled" }])).toBe(
        "New event: Untitled",
      );
    }
    expect(buildTitle([{ value: "  Ada  ", fallback: "Someone" }, " gave you kudos!"])).toBe(
      "Ada gave you kudos!",
    );
  });

  it("a 255-character source title: 255 code points, the prefix intact, an ellipsis", () => {
    const title = buildTitle([
      "New announcement: ",
      { value: "a".repeat(255), fallback: "Untitled" },
    ]);
    expect(codePoints(title)).toBe(NOTIFICATION_TITLE_MAX);
    expect(title.startsWith("New announcement: aaa")).toBe(true);
    expect(title.endsWith("a…")).toBe(true);
  });

  it("counts code points, as Postgres counts characters", () => {
    const emoji = "🎉".repeat(255); // 510 UTF-16 units
    const title = buildTitle(["New event: ", { value: emoji, fallback: "Untitled" }]);
    expect(codePoints(title)).toBe(NOTIFICATION_TITLE_MAX);
    expect(title.endsWith("🎉…")).toBe(true);
    // Never splits a surrogate pair.
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("leaves a title of exactly 255 code points alone", () => {
    const value = "b".repeat(NOTIFICATION_TITLE_MAX - "New event: ".length);
    const title = buildTitle(["New event: ", { value, fallback: "Untitled" }]);
    expect(title).toBe(`New event: ${value}`);
  });

  it("shortens the longest value first and keeps the quotes", () => {
    const title = buildTitle([
      { value: "Ada", fallback: "Someone" },
      ' commented on "',
      { value: "c".repeat(300), fallback: "an announcement" },
      '"',
    ]);
    expect(codePoints(title)).toBe(NOTIFICATION_TITLE_MAX);
    expect(title.startsWith('Ada commented on "ccc')).toBe(true);
    expect(title.endsWith('c…"')).toBe(true);
  });

  it("shortens two long values to the same length", () => {
    const title = buildTitle([
      { value: "n".repeat(255), fallback: "Someone" },
      ' commented on "',
      { value: "t".repeat(255), fallback: "an announcement" },
      '"',
    ]);
    expect(codePoints(title)).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
    const [name, rest] = title.split(' commented on "');
    expect(codePoints(name)).toBe(codePoints(rest) - 1);
    expect(name.endsWith("…")).toBe(true);
  });

  it("cuts even fixed text that alone is too long", () => {
    const title = buildTitle(["x".repeat(300)], 10);
    expect(title).toBe("xxxxxxxxx…");
  });
});

describe("buildNotification", () => {
  it("builds the create payload, actor falls back to null", () => {
    expect(
      buildNotification({
        type: "kudos",
        titleParts: [{ value: "Ada", fallback: "Someone" }, " gave you kudos!"],
        link: "/kudos",
        recipient: 7,
      }),
    ).toEqual({
      type: "kudos",
      title: "Ada gave you kudos!",
      link: "/kudos",
      recipient: 7,
      actor: null,
    });
  });

  it("carries the source anchor of a fan-out row", () => {
    const row = buildNotification({
      type: "announcement",
      titleParts: ["New announcement: ", { value: "a".repeat(255), fallback: "Untitled" }],
      link: "/announcements",
      recipient: 7,
      actor: 3,
      source: { sourceType: "announcement", sourceDocumentId: "doc1" },
    });
    expect(row).toMatchObject({
      type: "announcement",
      recipient: 7,
      actor: 3,
      sourceType: "announcement",
      sourceDocumentId: "doc1",
    });
    expect(codePoints(row.title)).toBe(NOTIFICATION_TITLE_MAX);
  });
});

const row = (recipient: number): NotificationData =>
  buildNotification({
    type: "event",
    titleParts: ["New event: x"],
    link: "/events",
    recipient,
    actor: 1,
    source: { sourceType: "event", sourceDocumentId: "e1" },
  });

describe("writeNotifications", () => {
  it("one create() per row, never createMany, and one log line", async () => {
    const strapi = createStrapiStub();
    await expect(writeNotifications(strapi, [row(7), row(8)], "event 3 (source e1)")).resolves.toBe(
      2,
    );
    expect(strapi.calls.map((call) => `${call.method} ${call.uid}`)).toEqual([
      `create ${NOTIFICATION_UID}`,
      `create ${NOTIFICATION_UID}`,
    ]);
    expect(strapi.tables[NOTIFICATION_UID].map((n) => n.recipient)).toEqual([{ id: 7 }, { id: 8 }]);
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[notifications] created 2 notification(s) for event 3 (source e1)",
    );
  });
});

describe("runSourceFanout", () => {
  const source = { id: 3, documentId: "e1", title: "Party" };

  it("dedups per recipient and writes anchored rows", async () => {
    const strapi = createStrapiStub({
      tables: {
        [NOTIFICATION_UID]: [
          { id: 1, sourceType: "event", sourceDocumentId: "e1", recipient: { id: 7 } },
        ],
      },
    });
    await runSourceFanout({
      strapi,
      sourceType: "event",
      row: source,
      loadAudience: async () => ({ source, recipients: [7, 8, 9], actorId: 1 }),
      titleParts: (r) => ["New event: ", { value: r.title, fallback: "Untitled" }],
      link: "/events",
    });
    const written = strapi.tables[NOTIFICATION_UID].slice(1);
    expect(written.map((n) => n.recipient)).toEqual([{ id: 8 }, { id: 9 }]);
    expect(written[0]).toMatchObject({
      type: "event",
      title: "New event: Party",
      link: "/events",
      actor: { id: 1 },
      sourceType: "event",
      sourceDocumentId: "e1",
    });
  });

  it("anchors on the lifecycle row when the re-read found nothing", async () => {
    const strapi = createStrapiStub();
    await runSourceFanout({
      strapi,
      sourceType: "event",
      row: source,
      loadAudience: async () => ({ source: null, recipients: [7], actorId: null }),
      titleParts: () => ["New event: x"],
      link: "/events",
    });
    expect(strapi.tables[NOTIFICATION_UID][0]).toMatchObject({
      sourceDocumentId: "e1",
      actor: null,
    });
  });

  it("never throws: a failing audience load is an error log", async () => {
    const strapi = createStrapiStub();
    await expect(
      runSourceFanout({
        strapi,
        sourceType: "announcement",
        row: source,
        loadAudience: async () => {
          throw new Error("db down");
        },
        titleParts: () => ["x"],
        link: "/announcements",
      }),
    ).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed to create notifications for announcement: db down",
    );
  });
});
