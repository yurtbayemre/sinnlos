import { describe, expect, it } from "vitest";
import { parseStrapiError, StrapiError } from "./strapi-error";

/**
 * StrapiError keeps its historic message and status and adds Strapi's own
 * error envelope (`{ data: null, error: { status, name, message } }`):
 * `strapiName` / `strapiMessage` (WD01). Anything that is not that envelope
 * answers nulls, never a throw.
 */
describe("StrapiError — Strapi's error envelope", () => {
  it("parses error.name and error.message", () => {
    const body = JSON.stringify({
      data: null,
      error: { status: 400, name: "ValidationError", message: "Already voted", details: {} },
    });
    expect(parseStrapiError(body)).toEqual({ name: "ValidationError", message: "Already voted" });
    const error = new StrapiError(400, "Bad Request", body);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      status: 400,
      strapiName: "ValidationError",
      strapiMessage: "Already voted",
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
    expect(parseStrapiError(body)).toEqual({ name: null, message: null });
    expect(new StrapiError(502, "Bad Gateway", body)).toMatchObject({
      status: 502,
      strapiName: null,
      strapiMessage: null,
    });
  });
});
