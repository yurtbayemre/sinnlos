import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web's language (AC04, owner decision 2026-09-29): the `locale`
 * cookie wins; without one, DEFAULT_LOCALE; unset or invalid, English —
 * the same default as compose, the .env examples, the user schema and the
 * cms's DIGEST_DEFAULT_LOCALE. next/headers' cookie jar is stubbed.
 */
const jar = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" && jar.locale !== undefined ? { value: jar.locale } : undefined,
  }),
}));

async function load(defaultLocale: string | undefined) {
  vi.resetModules();
  vi.stubEnv("DEFAULT_LOCALE", defaultLocale);
  return import("./locale");
}

beforeEach(() => {
  jar.locale = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getUserLocale", () => {
  it("falls back to English without DEFAULT_LOCALE", async () => {
    const { getUserLocale, FALLBACK_LOCALE } = await load(undefined);
    expect(FALLBACK_LOCALE).toBe("en");
    await expect(getUserLocale()).resolves.toBe("en");
  });

  it("falls back to English for an invalid DEFAULT_LOCALE, with a warning", async () => {
    const { getUserLocale } = await load("De");
    await expect(getUserLocale()).resolves.toBe("en");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to "en"'));
  });

  it("takes DEFAULT_LOCALE when it is a supported language", async () => {
    const { getUserLocale } = await load("de");
    await expect(getUserLocale()).resolves.toBe("de");
  });

  it("lets the cookie win, and ignores an unsupported cookie", async () => {
    const { getUserLocale } = await load("de");
    jar.locale = "en";
    await expect(getUserLocale()).resolves.toBe("en");
    jar.locale = "fr";
    await expect(getUserLocale()).resolves.toBe("de");
  });
});

describe("every shipped default language is English (AC04)", () => {
  const repo = (path: string) =>
    readFileSync(join(__dirname, "../../../..", path), "utf8").replace(/\r\n/g, "\n");

  it("the user schema's locale defaults to en", () => {
    const schema = JSON.parse(
      repo("apps/cms/src/extensions/users-permissions/content-types/user/schema.json"),
    ) as { attributes: { locale: { default?: string } } };
    expect(schema.attributes.locale.default).toBe("en");
  });

  it("compose and the .env examples default the UI and the digests to en", () => {
    const compose = repo("infra/docker-compose.yml");
    expect(compose).toContain("DEFAULT_LOCALE: ${DEFAULT_LOCALE:-en}");
    expect(compose).toContain("DIGEST_DEFAULT_LOCALE: ${DIGEST_DEFAULT_LOCALE:-en}");
    const infra = repo("infra/.env.example").split("\n");
    expect(infra).toContain("DEFAULT_LOCALE=en");
    expect(infra).toContain("DIGEST_DEFAULT_LOCALE=en");
    expect(repo("apps/web/.env.example").split("\n")).toContain("DEFAULT_LOCALE=en");
    expect(repo("apps/cms/.env.example").split("\n")).toContain("DIGEST_DEFAULT_LOCALE=en");
  });
});
