import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";

import { loadContentTypeSchemas } from "../test/strapi-stub.test.helper";
import {
  OFFSETLESS_GUARDED_ACTIONS,
  createOffsetlessDatetimeGuard,
  isOffsetLessInstantString,
  offsetlessKeys,
} from "./offsetless-datetime-guard";

/** DT-OFFSETLESS (decision 06 §F): the guard's decisions, per value and per action. */

const EVENT_ATTRIBUTES = {
  title: { type: "string" },
  start: { type: "datetime" },
  end: { type: "datetime" },
  stamp: { type: "timestamp" },
  day: { type: "date" },
  at: { type: "time" },
};

const guard = createOffsetlessDatetimeGuard();
const run = (
  action: string,
  data: unknown,
  attributes: Record<string, { type?: string }> = EVENT_ATTRIBUTES,
) => {
  const next = vi.fn(async () => "written");
  const result = guard({ action, params: { data }, contentType: { attributes } }, next);
  return { result, next };
};

describe("isOffsetLessInstantString", () => {
  it.each([
    "2026-10-01T07:00:00.000Z",
    "2026-10-01T07:00:00Z",
    "2026-10-01T07:00Z",
    "2026-10-01t07:00:00z",
    "2026-10-01T09:00:00+02:00",
    "2026-10-01T09:00:00.123456+0200",
    "2026-10-01T09:00+02",
    "2026-10-01 09:00:00-05:30",
    " 2026-10-01T07:00:00.000Z ",
  ])("accepts %s (Z or an offset)", (value) => {
    expect(isOffsetLessInstantString(value)).toBe(false);
  });

  it.each([
    "2026-10-01T09:00",
    "2026-10-01T09:00:00",
    "2026-10-01T09:00:00.000",
    "2026-10-01",
    "1696143600000",
    "",
    "tomorrow",
    "2026-10-01T09:00:00+2",
  ])("refuses %j (no zone)", (value) => {
    expect(isOffsetLessInstantString(value)).toBe(true);
  });

  it("lets non-strings pass: Date objects, numbers, null, undefined", () => {
    for (const value of [new Date(), 1_696_143_600_000, null, undefined, { $gt: 1 }]) {
      expect(isOffsetLessInstantString(value)).toBe(false);
    }
  });
});

describe("offsetlessKeys", () => {
  it("checks datetime and timestamp attributes only, never date or time", () => {
    expect(
      offsetlessKeys(EVENT_ATTRIBUTES, {
        title: "2026-10-01T09:00",
        start: "2026-10-01T09:00",
        end: "2026-10-01T10:00:00Z",
        stamp: "2026-10-01 10:00",
        day: "2026-10-01",
        at: "09:00:00.000",
      }),
    ).toEqual(["stamp", "start"]);
  });

  it("ignores keys that are no attribute, and data that is not an object", () => {
    expect(offsetlessKeys(EVENT_ATTRIBUTES, { unknown: "2026-10-01T09:00" })).toEqual([]);
    expect(offsetlessKeys(EVENT_ATTRIBUTES, null)).toEqual([]);
    expect(offsetlessKeys(EVENT_ATTRIBUTES, ["2026-10-01T09:00"])).toEqual([]);
  });
});

describe("the middleware", () => {
  it("guards create, update and clone", () => {
    expect(OFFSETLESS_GUARDED_ACTIONS).toEqual(["create", "update", "clone"]);
  });

  it.each(["create", "update", "clone"])(
    "%s with an offset-less instant answers 400 before the write, naming the keys",
    async (action) => {
      const { result, next } = run(action, { start: "2026-10-01T09:00", end: "2026-10-01T10:00" });
      const error = await result.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(errors.ValidationError);
      expect(error).toMatchObject({
        message: "Instants need Z or an offset (e.g. 2026-10-01T07:00:00.000Z): end, start",
        details: { keys: ["end", "start"] },
      });
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("passes Z, offsets, Date objects, numbers and null through", async () => {
    const { result, next } = run("update", {
      start: "2026-10-01T07:00:00.000Z",
      end: new Date(),
      stamp: 1_696_143_600_000,
      day: "2026-10-01",
    });
    await expect(result).resolves.toBe("written");
    expect(next).toHaveBeenCalledTimes(1);
    await expect(run("create", { start: null }).result).resolves.toBe("written");
  });

  it("leaves every other action alone, whatever its params", async () => {
    for (const action of ["publish", "unpublish", "discardDraft", "delete", "findMany", "count"]) {
      const { result, next } = run(action, { start: "2026-10-01T09:00" });
      await expect(result).resolves.toBe("written");
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("passes a write without data or without a content type", async () => {
    const next = vi.fn(async () => "written");
    await expect(guard({ action: "create", params: {} }, next)).resolves.toBe("written");
    await expect(
      guard({ action: "create", params: { data: { start: "2026-10-01T09:00" } } }, next),
    ).resolves.toBe("written");
  });
});

describe("the app's schemas (what the guard does not walk)", () => {
  it("have no components and no dynamic zones", () => {
    for (const [uid, schema] of Object.entries(loadContentTypeSchemas())) {
      for (const [key, attribute] of Object.entries(schema.attributes ?? {})) {
        expect(["component", "dynamiczone"], `${uid}.${key}`).not.toContain(attribute.type);
      }
    }
  });
});
