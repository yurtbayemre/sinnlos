import { describe, expect, it } from "vitest";
import { strapiJwtExp, strapiSessionExpired } from "./strapi-jwt";

/**
 * Expiry logic behind "the Auth.js session ends with the Strapi JWT"
 * (D-SESSION-01): the jwt callback in @/auth records strapiJwtExp at sign-in
 * and returns null once strapiSessionExpired() says so. auth.test.ts drives
 * the same rule through the real Auth.js handlers.
 */
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwtWith = (payload: unknown) => `${b64({ alg: "HS256" })}.${b64(payload)}.signature`;

const EXP = 1_900_000_000; // 2030-03-17
const AT_EXP_MS = EXP * 1000;

describe("strapiJwtExp", () => {
  it("decodes exp from a Strapi-shaped JWT without verifying it", () => {
    expect(strapiJwtExp(jwtWith({ id: 7, iat: EXP - 604800, exp: EXP }))).toBe(EXP);
  });

  it("is undefined for malformed tokens or a missing/non-numeric exp", () => {
    for (const jwt of [
      "",
      "not-a-jwt",
      "a.b",
      "a.b.c.d",
      `${b64({})}..sig`,
      `${b64({})}.%%%.sig`,
      `${b64({})}.${Buffer.from("not json").toString("base64url")}.sig`,
      jwtWith(null),
      jwtWith([EXP]),
      jwtWith({ id: 7 }),
      jwtWith({ exp: String(EXP) }),
    ]) {
      expect(strapiJwtExp(jwt), jwt).toBeUndefined();
    }
  });
});

describe("strapiSessionExpired", () => {
  const jwt = jwtWith({ id: 7, exp: EXP });

  it("keeps the session before exp and ends it at exp (inclusive)", () => {
    expect(strapiSessionExpired({ strapiJwt: jwt, strapiJwtExp: EXP }, AT_EXP_MS - 1)).toBe(false);
    expect(strapiSessionExpired({ strapiJwt: jwt, strapiJwtExp: EXP }, AT_EXP_MS)).toBe(true);
    expect(strapiSessionExpired({ strapiJwt: jwt, strapiJwtExp: EXP }, AT_EXP_MS + 1)).toBe(true);
  });

  it("prefers the recorded strapiJwtExp over the embedded one", () => {
    const earlier = EXP - 3600;
    expect(strapiSessionExpired({ strapiJwt: jwt, strapiJwtExp: earlier }, earlier * 1000)).toBe(
      true,
    );
  });

  it("falls back to the embedded exp for tokens issued before strapiJwtExp existed", () => {
    expect(strapiSessionExpired({ strapiJwt: jwt }, AT_EXP_MS - 1)).toBe(false);
    expect(strapiSessionExpired({ strapiJwt: jwt }, AT_EXP_MS)).toBe(true);
  });

  it("ends a session that carries no Strapi JWT (fail closed)", () => {
    expect(strapiSessionExpired({}, 0)).toBe(true);
    expect(strapiSessionExpired({ strapiJwt: "" }, 0)).toBe(true);
    expect(strapiSessionExpired({ strapiJwt: 42, strapiJwtExp: EXP }, 0)).toBe(true);
  });

  it("leaves a JWT without a readable exp to session.maxAge", () => {
    expect(strapiSessionExpired({ strapiJwt: "opaque-token" }, Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
  });
});
