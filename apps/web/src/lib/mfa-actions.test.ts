import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * v0.27 second-factor actions (lib/mfa-actions.ts): the cms answer's JWT
 * goes into the session (keepSessionSignedIn), the recovery codes come
 * back once, and every refusal becomes a code of the form. v0.34 (A-01):
 * both draw on one attempt budget per client IP and account.
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
/** The request's client IP and the session's user: a fresh pair per test (the budget is process-wide). */
const caller = vi.hoisted(() => ({ ip: "198.51.100.1", userId: 1 as number | undefined }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": caller.ip }),
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => (caller.userId === undefined ? null : { user: { id: caller.userId } }),
}));

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

let fresh = 0;
beforeEach(() => {
  fresh += 1;
  caller.ip = `198.51.100.${fresh}`;
  caller.userId = 1000 + fresh;
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

describe("the attempt budget (v0.34, A-01)", () => {
  const wrongPassword = () => strapiMock.mockRejectedValue(refusal(400, "password_invalid"));
  const activate = () => activateMfa({}, form({ enrollment: "x", code: "1", password: "p" }));
  const disable = () => disableMfa({}, form({ code: "1", password: "p" }));

  it("refuses the 11th wrong password of an account without asking the cms, across both actions and IPs", async () => {
    wrongPassword();
    for (let i = 0; i < 5; i += 1)
      await expect(activate()).resolves.toEqual({ error: "passwordInvalid" });
    for (let i = 0; i < 5; i += 1) {
      caller.ip = `203.0.113.${i}`;
      await expect(disable()).resolves.toEqual({ error: "passwordInvalid" });
    }
    strapiMock.mockClear();
    caller.ip = "203.0.113.99";
    await expect(activate()).resolves.toEqual({ error: "rateLimited" });
    await expect(disable()).resolves.toEqual({ error: "rateLimited" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("counts wrong codes like wrong passwords", async () => {
    strapiMock.mockRejectedValue(refusal(400, "mfa_invalid"));
    for (let i = 0; i < 10; i += 1)
      await expect(disable()).resolves.toEqual({ error: "mfaInvalid" });
    await expect(disable()).resolves.toEqual({ error: "rateLimited" });
  });

  it("blocks an IP that guesses for many accounts", async () => {
    wrongPassword();
    for (let i = 0; i < 10; i += 1) {
      caller.userId = 5000 + i;
      await expect(activate()).resolves.toEqual({ error: "passwordInvalid" });
    }
    caller.userId = 5999;
    await expect(activate()).resolves.toEqual({ error: "rateLimited" });
  });

  it("holds a place per attempt in flight: parallel guesses cannot pass the limit", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    strapiMock.mockImplementation(async () => {
      await gate;
      throw refusal(400, "password_invalid");
    });
    const results = Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? activate() : disable())),
    );
    await Promise.resolve();
    release();
    const errors = (await results).map((state) => state.error);
    expect(errors.filter((code) => code === "rateLimited")).toHaveLength(2);
    expect(strapiMock).toHaveBeenCalledTimes(10);
  });

  it("gives the place back for an outage, a throw or a redirect, and a success clears the account", async () => {
    strapiMock.mockRejectedValue(new StrapiError(503, "x", "{}"));
    for (let i = 0; i < 12; i += 1)
      await expect(disable()).resolves.toEqual({ error: "unavailable" });
    // What strapi() throws for a refused JWT (lib/strapi/client.ts).
    strapiMock.mockImplementation(async () => redirect("/sign-in?expired=1"));
    for (let i = 0; i < 12; i += 1) await expect(disable()).rejects.toThrow("NEXT_REDIRECT");
    wrongPassword();
    for (let i = 0; i < 9; i += 1) await disable();
    strapiMock.mockResolvedValue({ data: { jwt: "next.jwt" } });
    await expect(disable()).resolves.toEqual({ success: true });
    wrongPassword();
    caller.ip = "203.0.113.200";
    for (let i = 0; i < 10; i += 1)
      await expect(disable()).resolves.toEqual({ error: "passwordInvalid" });
  });

  it("frees the account after the 15-minute window", async () => {
    vi.useFakeTimers();
    try {
      wrongPassword();
      for (let i = 0; i < 10; i += 1) await activate();
      await expect(activate()).resolves.toEqual({ error: "rateLimited" });
      vi.advanceTimersByTime(15 * 60_000 + 1);
      await expect(activate()).resolves.toEqual({ error: "passwordInvalid" });
    } finally {
      vi.useRealTimers();
    }
  });
});
