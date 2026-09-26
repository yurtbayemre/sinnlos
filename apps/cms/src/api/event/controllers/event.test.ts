import { describe, expect, it, vi } from "vitest";
import eventController from "./event";

/**
 * The ICS export looks events up by NUMERIC row id through strapi.db.query,
 * which spans draft AND published rows — and the action is granted to every
 * role. FX06 pins the lookup to published rows, so a draft row id answers
 * the same 404 as a missing one (no unpublished title/location/time leak).
 *
 * The db stub evaluates the `where` it receives (id + the `$notNull` pin),
 * so the test fails if the pin is dropped, not only if it is spelled
 * differently.
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
  title: string;
  start: string;
  publishedAt: string | null;
}

const DRAFT: Row = {
  id: 1,
  title: "Secret offsite",
  start: "2026-10-01T10:00:00.000Z",
  publishedAt: null,
};
const PUBLISHED: Row = {
  id: 2,
  title: "Summer party",
  start: "2026-10-01T10:00:00.000Z",
  publishedAt: "2026-09-01T00:00:00.000Z",
};

type Where = Record<string, unknown>;

/** Minimal where evaluator: equality (ids arrive as strings) and `$notNull`. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return (cond as { $notNull: boolean }).$notNull ? value != null : value == null;
    }
    return String(value) === String(cond);
  });
}

function setup(id: string) {
  const findOne = vi.fn(
    async ({ where }: { where: Where }) =>
      [DRAFT, PUBLISHED].find((r) => matches(r, where)) ?? null,
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

describe("event ics (FX06)", () => {
  it("answers a draft row id exactly like a missing one", async () => {
    for (const id of [String(DRAFT.id), "999"]) {
      const { controller, ctx } = setup(id);
      await controller.ics(ctx);
      expect(ctx.notFound).toHaveBeenCalledWith();
      expect(ctx.body).toBeUndefined();
      expect(ctx.set).not.toHaveBeenCalled();
    }
  });

  it("pins the lookup to published rows", async () => {
    const { controller, ctx, findOne } = setup(String(DRAFT.id));
    await controller.ics(ctx);
    expect(findOne).toHaveBeenCalledWith({
      where: { id: String(DRAFT.id), publishedAt: { $notNull: true } },
    });
  });

  it("still exports a published event", async () => {
    const { controller, ctx } = setup(String(PUBLISHED.id));
    await controller.ics(ctx);
    expect(ctx.notFound).not.toHaveBeenCalled();
    expect(String(ctx.body)).toContain("BEGIN:VCALENDAR");
    expect(String(ctx.body)).toContain("SUMMARY:Summer party");
    // Timed event: UTC with Z (utils/ics-dates.ts).
    expect(String(ctx.body)).toContain("\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T100000Z\r\n");
  });
});
