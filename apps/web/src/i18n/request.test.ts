import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The next-intl request config (datetime contract, decision 04, C6): it
 * returns APP_TIME_ZONE as `timeZone`, so server formatting and the client
 * provider it feeds render every instant in the business zone instead of
 * the process zone (UTC in the container). getRequestConfig is next-intl's
 * identity wrapper; it and the cookie-backed locale lookup are stubbed.
 */
const localeMock = vi.fn<() => Promise<"en" | "de">>();

vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(create: T) => create,
}));
vi.mock("./locale", () => ({ getUserLocale: () => localeMock() }));

const { default: requestConfig } = await import("./request");
const en = (await import("../../messages/en.json")).default;
const de = (await import("../../messages/de.json")).default;

const load = () => requestConfig({ requestLocale: Promise.resolve(undefined) });

describe("i18n request config", () => {
  beforeEach(() => {
    localeMock.mockReset();
    localeMock.mockResolvedValue("en");
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats in APP_TIME_ZONE, Europe/Berlin when unset", async () => {
    vi.stubEnv("APP_TIME_ZONE", undefined);
    await expect(load()).resolves.toMatchObject({ locale: "en", timeZone: "Europe/Berlin" });
  });

  it("passes the canonical name of the configured zone", async () => {
    vi.stubEnv("APP_TIME_ZONE", "America/New_York");
    await expect(load()).resolves.toMatchObject({ timeZone: "America/New_York" });
    vi.stubEnv("APP_TIME_ZONE", "europe/berlin");
    await expect(load()).resolves.toMatchObject({ timeZone: "Europe/Berlin" });
  });

  it("never falls back to the process zone for an invalid value", async () => {
    vi.stubEnv("APP_TIME_ZONE", "+02:00");
    await expect(load()).rejects.toThrow(/APP_TIME_ZONE/);
    vi.stubEnv("APP_TIME_ZONE", "Nowhere/Zone");
    await expect(load()).rejects.toThrow(/IANA time zone name/);
  });

  it("loads the messages of the user's locale", async () => {
    localeMock.mockResolvedValue("de");
    const config = await load();
    expect(config.locale).toBe("de");
    expect(config.messages).toEqual(de);
    localeMock.mockResolvedValue("en");
    expect((await load()).messages).toEqual(en);
  });
});
