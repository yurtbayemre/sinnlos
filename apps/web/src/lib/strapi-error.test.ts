import { describe, expect, it } from "vitest";
import { parseStrapiError, StrapiError } from "./strapi-error";

/**
 * StrapiError keeps its historic message and status and adds Strapi's own
 * error envelope (`{ data: null, error: { status, name, message, details } }`):
 * `strapiName` / `strapiMessage` (WD01) and `strapiDetails` (AC01, decision
 * 06 §L3: the `keys`/`codes`/`current` runCmsAction maps). Anything that is
 * not that envelope answers nulls, never a throw.
 */
describe("StrapiError — Strapi's error envelope", () => {
  it("parses error.name and error.message", () => {
    const body = JSON.stringify({
      data: null,
      error: { status: 400, name: "ValidationError", message: "Already voted", details: {} },
    });
    expect(parseStrapiError(body)).toEqual({
      name: "ValidationError",
      message: "Already voted",
      details: {},
    });
    const error = new StrapiError(400, "Bad Request", body);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      status: 400,
      strapiName: "ValidationError",
      strapiMessage: "Already voted",
      strapiDetails: {},
      name: "StrapiError",
      message: `Strapi 400 Bad Request: ${body}`,
    });
  });

  it("reads the policy and not-found names too", () => {
    const envelope = (name: string, message: string) =>
      JSON.stringify({ data: null, error: { status: 403, name, message } });
    expect(
      new StrapiError(403, "Forbidden", envelope("PolicyError", "Policy Failed")),
    ).toMatchObject({ strapiName: "PolicyError", strapiMessage: "Policy Failed" });
    expect(new StrapiError(404, "Not Found", envelope("NotFoundError", "Not Found"))).toMatchObject(
      {
        strapiName: "NotFoundError",
      },
    );
  });

  it.each([
    ["an empty body", ""],
    ["plain text", "denied"],
    ["HTML from a proxy", "<html>502</html>"],
    ["JSON without the envelope", '{"data":[]}'],
    ["an error that is no object", '{"error":"boom"}'],
    ["an array", "[1,2]"],
    ["non-string fields", '{"error":{"name":7,"message":null}}'],
    ["empty strings", '{"error":{"name":"","message":""}}'],
  ])("answers nulls for %s", (_, body) => {
    expect(parseStrapiError(body)).toEqual({ name: null, message: null, details: null });
    expect(new StrapiError(502, "Bad Gateway", body)).toMatchObject({
      status: 502,
      strapiName: null,
      strapiMessage: null,
      strapiDetails: null,
    });
  });

  it("keeps details only when they are an object", () => {
    const envelope = (details: unknown) =>
      JSON.stringify({ data: null, error: { status: 400, name: "ValidationError", details } });
    const keys = { keys: ["title"], codes: { title: "tooLong" } };
    expect(parseStrapiError(envelope(keys)).details).toEqual(keys);
    expect(new StrapiError(412, "Precondition Failed", envelope({ current: "7" }))).toMatchObject({
      strapiDetails: { current: "7" },
    });
    for (const details of [null, "x", 7, ["title"]]) {
      expect(parseStrapiError(envelope(details)).details, JSON.stringify(details)).toBeNull();
    }
  });
});
