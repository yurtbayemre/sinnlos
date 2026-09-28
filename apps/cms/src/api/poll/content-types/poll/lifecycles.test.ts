import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import lifecycles from "./lifecycles";

/**
 * The poll lifecycle validates `options` for every writer (FX20), including
 * the admin panel, whose JSON input sends the raw editor text. The rules
 * themselves are pinned in utils/poll-options.test.ts.
 */

function run(hook: "beforeCreate" | "beforeUpdate", data: Record<string, unknown>) {
  const event = { params: { data } };
  lifecycles[hook](event);
  return event.params.data;
}

describe("poll lifecycle: options (FX20)", () => {
  it("stores admin-panel editor text as the normalised array", () => {
    for (const hook of ["beforeCreate", "beforeUpdate"] as const) {
      expect(run(hook, { options: '[\n  " Mon ",\n  "Tue"\n]' }).options).toEqual(["Mon", "Tue"]);
    }
  });

  it("normalises an array from the content API", () => {
    expect(run("beforeCreate", { question: "?", options: [" Mon", "Tue "] })).toEqual({
      question: "?",
      options: ["Mon", "Tue"],
    });
  });

  it("answers 1 option, 11 options, duplicates and non-JSON with a ValidationError", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `O${i}`);
    for (const options of [
      ["Only"],
      eleven,
      ["Mon", "Mon"],
      ["Mon", " Mon"],
      ["Mon", ""],
      '["Mon"]',
      '["Mon", "Mon"]',
      "Mon, Tue",
      "{}",
      42,
    ]) {
      expect(() => run("beforeCreate", { options }), JSON.stringify(options)).toThrow(
        errors.ValidationError,
      );
    }
    expect(() => run("beforeUpdate", { options: "Mon, Tue" })).toThrow("options: not valid JSON");
  });

  it("leaves payloads without options alone (audience guard, department cascade)", () => {
    expect(run("beforeUpdate", { audience: "departments" })).toEqual({ audience: "departments" });
    expect(run("beforeUpdate", { options: undefined })).toEqual({ options: undefined });
  });

  it("leaves a cleared field to Strapi's required rule", () => {
    expect(run("beforeUpdate", { options: null }).options).toBeNull();
    expect(run("beforeUpdate", { options: "" }).options).toBeNull();
    expect(run("beforeUpdate", { options: "  " }).options).toBeNull();
  });

  it("is idempotent across the publish re-run of beforeCreate", () => {
    const saved = run("beforeUpdate", { options: '["A ", " B"]' });
    expect(run("beforeCreate", { ...saved })).toEqual(saved);
  });

  it("ignores events without a data object", () => {
    expect(() => lifecycles.beforeCreate({})).not.toThrow();
    expect(() => lifecycles.beforeUpdate({ params: { data: null } })).not.toThrow();
  });
});
