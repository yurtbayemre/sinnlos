import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * The lesson video render gate (issue #29, FX09). YouTube's player refuses
 * to play without the embedding origin in the Referer ("Error 153"), so the
 * frame must send `strict-origin-when-cross-origin`, never `no-referrer`.
 * The embed URL stays rebuilt from the validated video id only, and the
 * frame title comes from the catalogs. `next-intl/server` is mocked with
 * the real catalogs (the component is an async Server Component).
 */
const state = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "training") => {
    const catalog = state.locale === "en" ? en : de;
    return (key: keyof (typeof en)["training"]) => catalog[namespace][key];
  },
}));

const { LessonVideo } = await import("./lesson-video");

async function render(videoUrl: string | null | undefined): Promise<string> {
  const element = await LessonVideo({ videoUrl });
  return element ? renderToStaticMarkup(element) : "";
}

describe("LessonVideo", () => {
  it("sends the origin as Referer so the YouTube player can verify the embed", async () => {
    const html = await render("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
    expect(html).not.toContain("no-referrer");
  });

  it("rebuilds the embed URL from the validated id and drops everything else", async () => {
    const html = await render('https://youtu.be/dQw4w9WgXcQ?t=42&x="><script>alert(1)</script>');
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("t=42");
  });

  it("names the frame in the UI language", async () => {
    state.locale = "en";
    expect(await render("https://youtu.be/dQw4w9WgXcQ")).toContain(
      `title="${en.training.videoTitle}"`,
    );
    state.locale = "de";
    expect(await render("https://youtu.be/dQw4w9WgXcQ")).toContain(
      `title="${de.training.videoTitle}"`,
    );
    state.locale = "en";
  });

  it("renders nothing for a URL that does not validate", async () => {
    for (const url of [
      null,
      undefined,
      "",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://evil.example/embed/x",
    ]) {
      expect(await render(url), String(url)).toBe("");
    }
  });
});
