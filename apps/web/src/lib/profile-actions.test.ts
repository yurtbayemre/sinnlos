import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "./strapi-error";

/**
 * FX11 for the change-password action: the client IP is forwarded as
 * X-Forwarded-For (the CMS trusts it via server.proxy.koa, like sign-in and
 * register), and Strapi's throttle 429 becomes the distinct
 * passwordRateLimited code instead of "check your current password". FX26
 * for the profile save: trimmed values, the 255-character limit answered
 * before any write, and a CMS 400 told apart from an outage. Both answer
 * machine codes (AC02); the forms translate them
 * (lib/auth/form-messages.ts, whose test checks both catalogs).
 * `@/lib/strapi` is mocked; its StrapiError is the real class.
 */
const strapiMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
const state = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string, init?: RequestInit) => strapiMock(path, init),
}));
const refreshMock = vi.fn();
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));
vi.mock("next/navigation", () => ({
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e;
  },
}));

const { changePassword, updateProfile } = await import("./profile-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  const values = {
    currentPassword: "old-password",
    password: "new-password",
    passwordConfirmation: "new-password",
    ...fields,
  };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ jwt: "x" });
  refreshMock.mockReset();
  state.headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The profile form as the browser submits it (checked boxes send "on"). */
const profileForm = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  const values = {
    displayName: "Sam Chen",
    jobTitle: "Engineer",
    phone: "+49 30 5678",
    officeLocation: "Remote",
    birthday: "1990-02-03",
    birthdayVisible: "on",
    digestKudos: "on",
    digestFrequency: "daily",
    ...fields,
  };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

/** The `data` object of the one PUT /api/me updateProfile sent. */
function sentProfile(): Record<string, unknown> {
  expect(strapiMock).toHaveBeenCalledTimes(1);
  const [path, init] = strapiMock.mock.calls[0]!;
  expect(path).toBe("/api/me");
  expect(init?.method).toBe("PUT");
  return (JSON.parse(String(init?.body)) as { data: Record<string, unknown> }).data;
}

describe("updateProfile (FX26)", () => {
  it("sends trimmed text fields and the coerced flags", async () => {
    const form = profileForm({
      displayName: "  Sam C.  ",
      jobTitle: "\tEngineer ",
      phone: " +49 30 1 ",
      officeLocation: " Remote\n",
    });
    await expect(updateProfile({}, form)).resolves.toEqual({ success: "profileSaved" });
    expect(sentProfile()).toEqual({
      displayName: "Sam C.",
      jobTitle: "Engineer",
      phone: "+49 30 1",
      officeLocation: "Remote",
      birthday: "1990-02-03",
      birthdayVisible: true,
      digestAnnouncements: false,
      digestMentions: false,
      digestKudos: true,
      digestFrequency: "daily",
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("sends an empty birthday as null and blank text as ''", async () => {
    await updateProfile({}, profileForm({ birthday: " ", displayName: "   " }));
    expect(sentProfile()).toMatchObject({ birthday: null, displayName: "" });
  });

  it("answers a text over 255 characters with the field's name, without a write", async () => {
    const result = await updateProfile({}, profileForm({ jobTitle: "x".repeat(300) }));
    expect(result).toMatchObject({ error: "tooLong", field: "jobTitle" });
    // The typed values come back, so the form keeps them.
    expect(result.values?.jobTitle).toBe("x".repeat(300));
    expect(result.values?.displayName).toBe("Sam Chen");
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("counts characters like the CMS: 255 after trimming and 255 emoji pass", async () => {
    await updateProfile({}, profileForm({ phone: ` ${"1".repeat(255)} ` }));
    expect((sentProfile().phone as string).length).toBe(255);
    strapiMock.mockClear();
    await updateProfile({}, profileForm({ officeLocation: "\u{1F3E2}".repeat(255) }));
    expect(sentProfile().officeLocation).toBe("\u{1F3E2}".repeat(255));
  });

  it("maps the CMS refusing a value (400) to invalid, never its message", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(400, "Bad Request", '{"error":{"message":"birthday must be a valid date"}}'),
    );
    const result = await updateProfile({}, profileForm());
    expect(result.error).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("birthday must");
    expect(result.values?.displayName).toBe("Sam Chen");
  });

  it("keeps the generic error and the typed values when the CMS is down", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const result = await updateProfile({}, profileForm({ jobTitle: "Lead" }));
    expect(result).toMatchObject({
      error: "profileSaveFailed",
      values: { jobTitle: "Lead" },
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s expired-session redirect escape", async () => {
    strapiMock.mockRejectedValue(new Error("NEXT_REDIRECT /sign-in?expired=1"));
    await expect(updateProfile({}, profileForm())).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("changePassword", () => {
  it("forwards the client IP to Strapi's change-password route", async () => {
    await expect(changePassword({}, form())).resolves.toEqual({ success: "passwordChanged" });
    const [path, init] = strapiMock.mock.calls[0]!;
    expect(path).toBe("/api/auth/change-password");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("maps Strapi's throttle (429) to the passwordRateLimited message", async () => {
    strapiMock.mockRejectedValue(new StrapiError(429, "Too Many Requests", "{}"));
    await expect(changePassword({}, form())).resolves.toEqual({ error: "passwordRateLimited" });
  });

  it("keeps the current-password hint for a rejected current password (400)", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(
        400,
        "Bad Request",
        '{"error":{"name":"ValidationError","message":"The provided current password is invalid"}}',
      ),
    );
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "passwordWrongOrThrottled",
    });
  });

  it.each([
    ["a 502", new StrapiError(502, "Bad Gateway", "")],
    ["a network error", new TypeError("fetch failed")],
  ])("says the change is unavailable for %s", async (_label, error) => {
    strapiMock.mockRejectedValue(error);
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "passwordChangeUnavailable",
    });
  });

  it("lets strapi()'s expired-session redirect escape", async () => {
    strapiMock.mockRejectedValue(new Error("NEXT_REDIRECT /sign-in?expired=1"));
    await expect(changePassword({}, form())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("validates locally before calling Strapi", async () => {
    await expect(changePassword({}, form({ password: "short" }))).resolves.toEqual({
      error: "passwordTooShort",
    });
    await expect(changePassword({}, form({ passwordConfirmation: "different" }))).resolves.toEqual({
      error: "passwordMismatch",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
