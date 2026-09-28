import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import lifecycles from "./lifecycles";

/**
 * The lesson lifecycle is the only validation chokepoint for admin writes.
 * FX08: it writes the normalised quiz back into `event.params.data.quiz`, so
 * an admin-edited quiz (raw editor text) is stored as the array and a cleared
 * one ('') as null. Keys that are not in `data` stay untouched, and the
 * publish re-run of beforeCreate is a no-op on already normalised data.
 */

const QUESTION = { question: "2+2?", options: ["3", "4"], correctIndex: 1 };

function run(hook: "beforeCreate" | "beforeUpdate", data: Record<string, unknown>) {
  const event = { params: { data } };
  lifecycles[hook](event);
  return event.params.data;
}

describe("lesson lifecycle (FX08)", () => {
  it("stores an admin-edited quiz as the validated array", () => {
    const text = JSON.stringify([{ ...QUESTION, options: [" 3 ", "4"] }], null, 2);
    for (const hook of ["beforeCreate", "beforeUpdate"] as const) {
      expect(run(hook, { title: "L", quiz: text }).quiz).toEqual([QUESTION]);
    }
  });

  it("stores a cleared quiz as null", () => {
    expect(run("beforeUpdate", { quiz: "" }).quiz).toBeNull();
    expect(run("beforeUpdate", { quiz: "   " }).quiz).toBeNull();
  });

  it("does not add a quiz key the payload did not have", () => {
    const data = run("beforeUpdate", { title: "L", order: 2 });
    expect("quiz" in data).toBe(false);
  });

  it("is idempotent across the publish re-run of beforeCreate", () => {
    const saved = run("beforeUpdate", { quiz: JSON.stringify([QUESTION]) });
    const published = run("beforeCreate", { ...saved });
    expect(published).toEqual(saved);
  });

  it("answers invalid data with an ApplicationError (a 400 in the admin panel)", () => {
    for (const data of [{ quiz: "[{" }, { quiz: "[]x" }, { quiz: "{}" }, { videoUrl: "https://vimeo.com/1" }]) {
      expect(() => run("beforeUpdate", data)).toThrow(errors.ApplicationError);
    }
    expect(() => run("beforeUpdate", { quiz: "[{" })).toThrow("quiz ist kein gültiges JSON");
  });

  it("ignores events without a data object", () => {
    expect(() => lifecycles.beforeCreate({})).not.toThrow();
    expect(() => lifecycles.beforeUpdate({ params: { data: null } })).not.toThrow();
  });
});
