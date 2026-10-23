import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * v0.27 second-factor actions (lib/mfa-actions.ts): the cms answer's JWT
 * goes into the session (keepSessionSignedIn), the recovery codes come
 * back once, and every refusal becomes a code of the form.
 */
const strapiMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock("@/lib/strapi", () => ({
  strapi: (path: string, init?: RequestInit) => strapiMock(path, init),
}));
const keepMock = vi.fn<(jwt: unknown, label: string) => Promise<void>>();
vi.mock("@/lib/auth/keep-session", () => ({
  keepSessionSignedIn: (jwt: unknown, label: string) => keepMock(jwt, label),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));

const { activateMfa, disableMfa } = await import("./mfa-actions");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const refusal = (status: number, code: string) =>
  new StrapiError(
    status,
    "x",
    JSON.stringify({ data: null, error: { status, name: "ValidationError", details: { code } } }),
  );

beforeEach(() => {
  strapiMock.mockReset();
  keepMock.mockReset();
  keepMock.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("activateMfa", () => {
  it("posts enrollment, code and password, keeps the session and answers the codes", async () => {
    strapiMock.mockResolvedValue({ data: { jwt: "new.jwt", recoveryCodes: ["aaaaa-bbbbb", 7] } });
    await expect(
      activateMfa({}, form({ enrollment: "sealed", code: " 123456 ", password: "pw" })),
    ).resolves.toEqual({ recoveryCodes: ["aaaaa-bbbbb"] });
    const [path, init] = strapiMock.mock.calls[0]!;
    expect(path).toBe("/api/me/mfa/activate");
    expect(JSON.parse(String(init?.body))).toEqual({
      enrollment: "sealed",
      code: "123456",
      password: "pw",
    });
    expect(keepMock).toHaveBeenCalledWith("new.jwt", "[mfa] activate");
  });

  it.each([
    ["enrollment_invalid", "enrollmentInvalid"],
    ["password_invalid", "passwordInvalid"],
    ["mfa_invalid", "mfaInvalid"],
    ["already_enabled", "alreadyEnabled"],
    ["mfa_unavailable", "unavailable"],
    ["something_else", "failed"],
  ])("maps %s to %s without touching the session", async (cmsCode, code) => {
    strapiMock.mockRejectedValue(refusal(400, cmsCode));
    await expect(
      activateMfa({}, form({ enrollment: "x", code: "1", password: "p" })),
    ).resolves.toEqual({ error: code });
    expect(keepMock).not.toHaveBeenCalled();
  });
});

describe("disableMfa", () => {
  it("turns it off and keeps the session with the new JWT", async () => {
    strapiMock.mockResolvedValue({ data: { jwt: "next.jwt" } });
    await expect(disableMfa({}, form({ code: "123456", password: "pw" }))).resolves.toEqual({
      success: true,
    });
    expect(strapiMock.mock.calls[0]![0]).toBe("/api/me/mfa/disable");
    expect(keepMock).toHaveBeenCalledWith("next.jwt", "[mfa] disable");
  });

  it("says when the role requires the second factor", async () => {
    strapiMock.mockRejectedValue(refusal(403, "mfa_required_by_role"));
    await expect(disableMfa({}, form({ code: "1", password: "p" }))).resolves.toEqual({
      error: "requiredByRole",
    });
  });
});
