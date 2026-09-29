import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * switchLocale (AC04): the cookie switches the web's language, and the
 * choice is stored on the profile (PUT /api/me { locale }) so the digests
 * speak it. The profile write is best-effort (a failure keeps the cookie),
 * skipped in DEMO_MODE and without a session; strapi()'s sign-in redirect
 * propagates. next/navigation is the real module.
 */
const state = vi.hoisted(() => ({
  demo: false,
  session: { user: { id: 7 } } as { user?: { id?: number } } | null,
}));
const strapiMock = vi.fn();
const setUserLocaleMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/config", () => ({
  get DEMO_MODE() {
    return state.demo;
  },
}));
vi.mock("@/i18n/locale", () => ({
  SUPPORTED_LOCALES: ["en", "de"],
  setUserLocale: (locale: string) => setUserLocaleMock(locale),
}));

const { switchLocale } = await import("./locale-actions");

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

beforeEach(() => {
  state.demo = false;
  state.session = { user: { id: 7 } };
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 7, locale: "de" } });
  setUserLocaleMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("switchLocale", () => {
  it.each(["en", "de"] as const)(
    "sets the %s cookie and stores it on the profile",
    async (locale) => {
      await expect(switchLocale(locale)).resolves.toBeUndefined();
      expect(setUserLocaleMock).toHaveBeenCalledWith(locale);
      expect(strapiMock).toHaveBeenCalledWith("/api/me", {
        method: "PUT",
        body: JSON.stringify({ data: { locale } }),
      });
    },
  );

  it("keeps the switched cookie when the profile write fails (best-effort)", async () => {
    for (const error of [
      new StrapiError(500, "Internal Server Error", ""),
      new TypeError("fetch failed"),
    ]) {
      strapiMock.mockRejectedValueOnce(error);
      await expect(switchLocale("de")).resolves.toBeUndefined();
    }
    expect(setUserLocaleMock).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("lets strapi()'s sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(switchLocale("de")).rejects.toBe(redirectError);
  });

  it("skips the profile write in DEMO_MODE and without a session", async () => {
    state.demo = true;
    await switchLocale("de");
    state.demo = false;
    state.session = null;
    await switchLocale("en");
    expect(setUserLocaleMock).toHaveBeenCalledTimes(2);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("refuses a language the web does not have, before anything is written", async () => {
    await switchLocale("fr" as "en");
    await switchLocale("__proto__" as "en");
    expect(setUserLocaleMock).not.toHaveBeenCalled();
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
