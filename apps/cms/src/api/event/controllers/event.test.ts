import { validateHeaderValue } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import eventController from "./event";

/**
 * The ICS export (GET /api/events/:id/ics) looks an event up through
 * strapi.db.query, which spans draft AND published rows — and the action is
 * granted to every role. Pinned here:
 *
 *  1. FX06: the lookup is pinned to published rows, so a draft row id or a
 *     draft-only documentId answers the same 404 as a missing entry (no
 *     unpublished title/location/time leak).
 *  2. EVT-ICS-ID: `:id` is a documentId (what the web links) or a numeric
 *     row id (links from before 2026-09-27). Anything else answers that 404
 *     WITHOUT a query: on Postgres a malformed value in the int4 `id`
 *     lookup is an error, which Strapi answered with a 500.
 *  3. The UID is built from the documentId, so a re-published event (new
 *     published row id) keeps its UID and calendar clients update it
 *     instead of importing it twice.
 *  4. FX12: the file comes from utils/ics.ts (its rules are pinned in
 *     ics.test.ts); a title outside Latin-1 gets an RFC 6266 header instead
 *     of the 500 Node's header check caused.
 *
 * The db stub evaluates the `where` it receives (id / documentId + the
 * `$notNull` pin), so the test fails if the pin is dropped, not only if it
 * is spelled differently.
 */

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

interface Row {
  id: number;
  documentId: string;
  title: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  publishedAt: string | null;
}

/** Strapi 5 documentIds (cuid2): a lowercase letter + 23 of [a-z0-9]. */
const PARTY_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const OFFSITE_DOC = "a1b2c3d4e5f6g7h8i9j0k1l2";
const UNKNOWN_DOC = "zzzzzzzzzzzzzzzzzzzzzzzz";

/** A draft-only event: never published. */
const OFFSITE_DRAFT: Row = {
  id: 1,
  documentId: OFFSITE_DOC,
  title: "Secret offsite",
  start: "2026-10-01T10:00:00.000Z",
  publishedAt: null,
};
/** A published event: its draft row and its published row. */
const PARTY_DRAFT: Row = {
  id: 2,
  documentId: PARTY_DOC,
  title: "Summer party (draft edit)",
  start: "2026-10-01T10:00:00.000Z",
  publishedAt: null,
};
const PARTY_PUBLISHED: Row = {
  id: 3,
  documentId: PARTY_DOC,
  title: "Summer party",
  start: "2026-10-01T10:00:00.000Z",
  location: "Roof; terrace, Berlin",
  publishedAt: "2026-09-01T00:00:00.000Z",
};

type Where = Record<string, unknown>;

/** Minimal where evaluator: equality and `$notNull`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return (cond as { $notNull: boolean }).$notNull ? value != null : value == null;
    }
    return value === cond;
  });
}

function setup(id: unknown, rows: Row[] = [OFFSITE_DRAFT, PARTY_DRAFT, PARTY_PUBLISHED]) {
  const findOne = vi.fn(
    async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
  );
  const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
  const controller = (
    eventController as unknown as (deps: { strapi: unknown }) => {
      ics(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    params: { id },
    body: undefined as unknown,
    notFound: vi.fn(),
    set: vi.fn(),
  };
  return { controller, ctx, findOne };
}

async function ics(id: unknown, rows?: Row[]) {
  const s = setup(id, rows);
  await s.controller.ics(s.ctx);
  return s;
}

function expectNotFound(ctx: ReturnType<typeof setup>["ctx"]) {
  expect(ctx.notFound).toHaveBeenCalledWith();
  expect(ctx.body).toBeUndefined();
  expect(ctx.set).not.toHaveBeenCalled();
}

describe("event ics: published rows only (FX06)", () => {
  it("answers a draft row id and a draft-only documentId exactly like a missing entry", async () => {
    for (const id of [
      String(OFFSITE_DRAFT.id),
      String(PARTY_DRAFT.id),
      OFFSITE_DOC,
      "999",
      UNKNOWN_DOC,
    ]) {
      const { ctx, findOne } = await ics(id);
      expectNotFound(ctx);
      expect(findOne).toHaveBeenCalledTimes(1);
    }
  });

  it("pins the lookup to published rows, by row id and by documentId", async () => {
    const byId = await ics(String(PARTY_DRAFT.id));
    expect(byId.findOne).toHaveBeenCalledWith({
      where: { id: PARTY_DRAFT.id, publishedAt: { $notNull: true } },
    });
    const byDocument = await ics(OFFSITE_DOC);
    expect(byDocument.findOne).toHaveBeenCalledWith({
      where: { documentId: OFFSITE_DOC, publishedAt: { $notNull: true } },
    });
  });
});

describe("event ics: documentId or numeric id (EVT-ICS-ID)", () => {
  it("exports a published event by its documentId", async () => {
    const { ctx } = await ics(PARTY_DOC);
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(String(ctx.body)).toContain("SUMMARY:Summer party\r\n");
  });

  it("still exports a published event by the numeric id of its published row", async () => {
    const { ctx } = await ics(String(PARTY_PUBLISHED.id));
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(String(ctx.body)).toContain("SUMMARY:Summer party\r\n");
  });

  it("answers anything else with the same 404, without a query", async () => {
    for (const id of [
      undefined,
      null,
      "",
      " ",
      "abc",
      "doc-1",
      "1.5",
      "1e3",
      "0",
      "00",
      "01",
      "-1",
      "+1",
      " 1",
      "1 ",
      "0x10",
      "2147483648", // int4 max + 1
      "9999999999",
      "99999999999999999999",
      "1".repeat(400),
      "Infinity",
      "NaN",
      PARTY_DOC.toUpperCase(),
      PARTY_DOC.slice(1), // 23 characters
      `${PARTY_DOC}a`, // 25 characters
      `1${PARTY_DOC.slice(1)}`, // starts with a digit
      `${PARTY_DOC.slice(0, 23)}-`,
      `${PARTY_DOC}\n`,
      "../../users",
      "%2e%2e",
    ]) {
      const { ctx, findOne } = await ics(id);
      expectNotFound(ctx);
      expect(findOne, `id ${JSON.stringify(id)}`).not.toHaveBeenCalled();
    }
  });

  it("looks up the largest int4 row id", async () => {
    const { ctx, findOne } = await ics("2147483647");
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 2147483647, publishedAt: { $notNull: true } },
    });
    expectNotFound(ctx);
  });
});

describe("event ics: output", () => {
  it("uses the documentId in the UID, stable across a re-publish", async () => {
    const before = await ics(PARTY_DOC);
    // Publishing again re-creates the published row with a new id.
    const republished = [OFFSITE_DRAFT, PARTY_DRAFT, { ...PARTY_PUBLISHED, id: 17 }];
    const after = await ics(PARTY_DOC, republished);
    const byOldRowId = await ics(String(PARTY_PUBLISHED.id), republished);

    const uid = `\r\nUID:event-${PARTY_DOC}@sinnlos\r\n`;
    expect(String(before.ctx.body)).toContain(uid);
    expect(String(after.ctx.body)).toContain(uid);
    // An old numeric link names the replaced row: gone, like any unknown id.
    expectNotFound(byOldRowId.ctx);
  });

  it("keeps the calendar layout: timed event in UTC with Z, escaped text", async () => {
    const { ctx } = await ics(PARTY_DOC);
    const body = String(ctx.body);
    expect(
      body.startsWith(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sinnlos//Events//EN\r\nBEGIN:VEVENT\r\n",
      ),
    ).toBe(true);
    expect(body).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
    expect(body).toContain("\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T100000Z\r\n");
    expect(body).toContain("\r\nLOCATION:Roof\\; terrace\\, Berlin\r\n");
    expect(body).toMatch(/\r\nSEQUENCE:\d+\r\n/);
    expect(body.endsWith("\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ctx.set).toHaveBeenCalledWith("Content-Type", "text/calendar; charset=utf-8");
    expect(ctx.set).toHaveBeenCalledWith(
      "Content-Disposition",
      "attachment; filename=\"Summer party.ics\"; filename*=UTF-8''Summer%20party.ics",
    );
  });

  it("exports a non-ASCII title with a header value Node accepts (FX12: was a 500)", async () => {
    const title = "Sommerfest – 5 € 🎉";
    // What the handler used to send: Node refuses the value (ERR_INVALID_CHAR),
    // which Strapi answered with a 500.
    expect(() =>
      validateHeaderValue("Content-Disposition", `attachment; filename="${title}.ics"`),
    ).toThrow(expect.objectContaining({ code: "ERR_INVALID_CHAR" }));

    const { ctx } = await ics(PARTY_DOC, [{ ...PARTY_PUBLISHED, title }]);
    expect(ctx.notFound).not.toHaveBeenCalled();
    const disposition = ctx.set.mock.calls.find(([name]) => name === "Content-Disposition")?.[1];
    expect(disposition).toBe(
      "attachment; filename=\"Sommerfest - 5 EUR.ics\"; " +
        "filename*=UTF-8''Sommerfest%20%E2%80%93%205%20%E2%82%AC%20%F0%9F%8E%89.ics",
    );
    expect(() => validateHeaderValue("Content-Disposition", disposition)).not.toThrow();
    expect(String(ctx.body)).toContain(`\r\nSUMMARY:${title}\r\n`);
  });

  it("keeps all-day events as calendar days (VALUE=DATE)", async () => {
    vi.stubEnv("APP_TIME_ZONE", "Europe/Berlin");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const allDay: Row = {
      ...PARTY_PUBLISHED,
      allDay: true,
      // 2026-06-26 00:00 in Europe/Berlin.
      start: "2026-06-25T22:00:00.000Z",
      end: null,
    };
    const { ctx } = await ics(PARTY_DOC, [allDay]);
    expect(String(ctx.body)).toContain(
      "\r\nDTSTART;VALUE=DATE:20260626\r\nDTEND;VALUE=DATE:20260627\r\n",
    );
  });
});
