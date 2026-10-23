import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, totpStep } from "./totp";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890".
const SECRET = Buffer.from("12345678901234567890", "ascii");
const VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 vectors (8 digits)", () => {
    for (const [seconds, code] of VECTORS) {
      expect(hotp(SECRET, totpStep(seconds * 1000), 8)).toBe(code);
    }
  });

  it("accepts the current step and one step either way, nothing else", () => {
    const at = 1234567890 * 1000;
    const step = totpStep(at);
    expect(matchTotp(SECRET, hotp(SECRET, step), at)).toBe(step);
    expect(matchTotp(SECRET, hotp(SECRET, step - 1), at)).toBe(step - 1);
    expect(matchTotp(SECRET, hotp(SECRET, step + 1), at)).toBe(step + 1);
    expect(matchTotp(SECRET, hotp(SECRET, step - 2), at)).toBeNull();
    expect(matchTotp(SECRET, "12345", at)).toBeNull();
    expect(matchTotp(SECRET, "abcdef", at)).toBeNull();
  });

  it("round-trips base32 (RFC 4648) and refuses other characters", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw6ytboi")?.toString()).toBe("foobar");
    expect(base32Decode("MZXW 6YTB OI")?.toString()).toBe("foobar");
    expect(base32Decode("MZXW1")).toBeNull();
  });

  it("builds an otpauth URI with an escaped label", () => {
    expect(otpauthUri("ABC", "anna@example.com", "sinnlos")).toBe(
      "otpauth://totp/sinnlos%3Aanna%40example.com?secret=ABC&issuer=sinnlos&algorithm=SHA1&digits=6&period=30",
    );
  });
});
