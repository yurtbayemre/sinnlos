import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * mediaUrl / avatarThumbUrl (WD10). The web serves /uploads itself (the
 * session-gated proxy, §7b P1.4), so a local-provider path stays relative
 * whatever STRAPI_PUBLIC_URL says; absolute provider URLs pass through; any
 * other relative URL keeps the public CMS base. The module reads the env at
 * load time, so each case loads it fresh.
 */
async function load(publicUrl: string | undefined) {
  vi.resetModules();
  vi.stubEnv("STRAPI_PUBLIC_URL", publicUrl ?? "");
  return import("./config");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mediaUrl", () => {
  it.each([undefined, "https://cms.example.test"])(
    "keeps a local-provider /uploads path relative (STRAPI_PUBLIC_URL=%s)",
    async (publicUrl) => {
      const { mediaUrl } = await load(publicUrl);
      expect(mediaUrl("/uploads/avatar_abc.png")).toBe("/uploads/avatar_abc.png");
      expect(mediaUrl("/uploads/thumbnail_avatar_abc.png")).toBe(
        "/uploads/thumbnail_avatar_abc.png",
      );
    },
  );

  it("passes absolute provider URLs through", async () => {
    const { mediaUrl } = await load("https://cms.example.test");
    expect(mediaUrl("https://bucket.s3.example.test/a.png")).toBe(
      "https://bucket.s3.example.test/a.png",
    );
    expect(mediaUrl("http://cdn.example.test/a.png")).toBe("http://cdn.example.test/a.png");
  });

  it("prefixes any other relative URL with the public CMS base, if one is set", async () => {
    expect((await load("https://cms.example.test")).mediaUrl("/files/a.pdf")).toBe(
      "https://cms.example.test/files/a.pdf",
    );
    expect((await load(undefined)).mediaUrl("/files/a.pdf")).toBe("/files/a.pdf");
    // "/uploads" without the slash is not the provider's path.
    expect((await load("https://cms.example.test")).mediaUrl("/uploadsx/a.png")).toBe(
      "https://cms.example.test/uploadsx/a.png",
    );
  });

  it("answers null for no URL", async () => {
    const { mediaUrl } = await load("https://cms.example.test");
    expect(mediaUrl(null)).toBeNull();
    expect(mediaUrl(undefined)).toBeNull();
    expect(mediaUrl("")).toBeNull();
  });
});

describe("avatarThumbUrl", () => {
  it("prefers the thumbnail, then small, then the original, all relative", async () => {
    const { avatarThumbUrl } = await load("https://cms.example.test");
    const formats = {
      thumbnail: { url: "/uploads/thumbnail_a.png" },
      small: { url: "/uploads/small_a.png" },
    };
    expect(avatarThumbUrl({ url: "/uploads/a.png", formats })).toBe("/uploads/thumbnail_a.png");
    expect(avatarThumbUrl({ url: "/uploads/a.png", formats: { small: formats.small } })).toBe(
      "/uploads/small_a.png",
    );
    expect(avatarThumbUrl({ url: "/uploads/a.png", formats: null })).toBe("/uploads/a.png");
  });

  it("passes an external provider's absolute rendition through", async () => {
    const { avatarThumbUrl } = await load("https://cms.example.test");
    expect(
      avatarThumbUrl({ formats: { thumbnail: { url: "https://bucket.example.test/t.png" } } }),
    ).toBe("https://bucket.example.test/t.png");
  });

  it("answers null without an avatar or any URL", async () => {
    const { avatarThumbUrl } = await load(undefined);
    expect(avatarThumbUrl(null)).toBeNull();
    expect(avatarThumbUrl(undefined)).toBeNull();
    expect(avatarThumbUrl({})).toBeNull();
  });
});
