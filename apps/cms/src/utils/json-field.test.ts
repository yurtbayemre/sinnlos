import { describe, expect, it } from "vitest";

import { parseAdminJsonField } from "./json-field";

/**
 * The admin panel's JSON input hands a lifecycle the raw editor text once a
 * field was edited and '' once it was cleared (Strapi 5.55.1, see the module
 * header); untouched fields and content-API writers send parsed JSON.
 */
describe("parseAdminJsonField", () => {
  it("parses editor text", () => {
    expect(parseAdminJsonField('[\n  "a",\n  "b"\n]')).toEqual({ ok: true, value: ["a", "b"] });
    expect(parseAdminJsonField('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseAdminJsonField("null")).toEqual({ ok: true, value: null });
    expect(parseAdminJsonField('"text"')).toEqual({ ok: true, value: "text" });
  });

  it("reads an empty or whitespace-only string as a cleared field (null)", () => {
    for (const value of ["", " ", "\n", "\t \r\n"]) {
      expect(parseAdminJsonField(value)).toEqual({ ok: true, value: null });
    }
  });

  it("refuses text that is not JSON", () => {
    for (const value of ["[", "a, b", "['a']", "{a:1}", "undefined", "[1,]"]) {
      expect(parseAdminJsonField(value), value).toEqual({ ok: false });
    }
  });

  it("returns parsed values unchanged", () => {
    const array = ["a", "b"];
    const object = { a: 1 };
    expect(parseAdminJsonField(array)).toEqual({ ok: true, value: array });
    expect((parseAdminJsonField(array) as { value: unknown }).value).toBe(array);
    expect((parseAdminJsonField(object) as { value: unknown }).value).toBe(object);
    for (const value of [null, undefined, 0, 1.5, true, false]) {
      expect(parseAdminJsonField(value)).toEqual({ ok: true, value });
    }
  });
});
