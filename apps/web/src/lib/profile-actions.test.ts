import { beforeEach, describe, expect, it, vi } from "vitest";
import de from "../../messages/de.json";
import en from "../../messages/en.json";
import { StrapiError } from "./strapi-error";

/**
 * FX11 for the change-password action: the client IP is forwarded as
 * X-Forwarded-For (the CMS trusts it via server.proxy.koa, like sign-in and
 * register), and Strapi's throttle 429 becomes the distinct
 * profile.passwordRateLimited message instead of "check your current
 * password". FX26 for the profile save: trimmed values, the 255-character
 * limit answered before any write, and a CMS 400 told apart from an
 * outage. Every message comes from the catalogs (profile.*), in the
 * viewer's language: the translator stub answers the key and throws for a
 * key that en.json or de.json lacks. `@/lib/strapi` is mocked; its
 * StrapiError is the real class.
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
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "profile") => (key: string, values?: object) => {
    for (const catalog of [en, de]) {
      if (typeof (catalog[namespace] as Record<string, unknown>)[key] !== "string") {
        throw new Error(`missing message ${namespace}.${key}`);
      }
    }
    return values ? `${namespace}.${key} ${JSON.stringify(values)}` : `${namespace}.${key}`;
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
    await expect(updateProfile({}, form)).resolves.toEqual({ success: "profile.profileUpdated" });
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
    expect(result.error).toBe('profile.error_tooLong {"field":"profile.jobTitle","max":255}');
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

  it("maps the CMS refusing a value (400) to a translated message", async () => {
    strapiMock.mockRejectedValue(new StrapiError(400, "Bad Request", "{}"));
    const result = await updateProfile({}, profileForm());
    expect(result.error).toBe("profile.error_invalid");
    expect(result.values?.displayName).toBe("Sam Chen");
  });

  it("keeps the generic error and the typed values when the CMS is down", async () => {
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    const result = await updateProfile({}, profileForm({ jobTitle: "Lead" }));
    expect(result).toMatchObject({
      error: "profile.error_saveFailed",
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
    await expect(changePassword({}, form())).resolves.toEqual({
      success: "profile.passwordChanged",
    });
    const [path, init] = strapiMock.mock.calls[0]!;
    expect(path).toBe("/api/auth/change-password");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("maps Strapi's throttle (429) to the passwordRateLimited message", async () => {
    strapiMock.mockRejectedValue(new StrapiError(429, "Too Many Requests", "{}"));
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "profile.passwordRateLimited",
    });
  });

  it("keeps the current-password hint for a rejected current password (400)", async () => {
    strapiMock.mockRejectedValue(new StrapiError(400, "Bad Request", "{}"));
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "profile.passwordChangeFailed",
    });
  });

  it("lets strapi()'s expired-session redirect escape", async () => {
    strapiMock.mockRejectedValue(new Error("NEXT_REDIRECT /sign-in?expired=1"));
    await expect(changePassword({}, form())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("validates locally before calling Strapi", async () => {
    await expect(changePassword({}, form({ password: "short" }))).resolves.toEqual({
      error: 'profile.passwordTooShort {"min":6}',
    });
    await expect(changePassword({}, form({ passwordConfirmation: "different" }))).resolves.toEqual({
      error: "profile.passwordMismatch",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
