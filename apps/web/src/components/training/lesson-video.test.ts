import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * The lesson video (issues #29, #37, FX09). Before the click the page holds
 * only the facade: no frame and no YouTube address in the markup, so nothing
 * is requested from YouTube. The frame it renders on the click keeps the
 * security layer: the embed URL rebuilt from the validated video id only,
 * a sandbox, and `strict-origin-when-cross-origin` (YouTube's player refuses
 * to play without the embedding origin in the Referer, "Error 153").
 * `next-intl/server` is mocked with the real catalogs (async Server Component).
 */
const state = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "training") => {
    const catalog = state.locale === "en" ? en : de;
    return (key: keyof (typeof en)["training"]) => catalog[namespace][key];
  },
}));

const { LessonVideo, lessonVideoSrc } = await import("./lesson-video");
const { LessonVideoFrame } = await import("./video-facade");

async function render(videoUrl: string | null | undefined): Promise<string> {
  const element = await LessonVideo({ videoUrl });
  return element ? renderToStaticMarkup(element) : "";
}

describe("LessonVideo", () => {
  it("shows only the play button before the click: no frame, no YouTube request", async () => {
    const html = await render("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(html).toContain('<button type="button"');
    expect(html).toContain(en.training.videoPlay);
    expect(html).toContain(en.training.videoNotice);
    expect(html).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1"/);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("youtube");
    expect(html).not.toContain("ytimg");
  });

  it("rebuilds the embed URL from the validated id and drops everything else", () => {
    expect(lessonVideoSrc('https://youtu.be/dQw4w9WgXcQ?t=42&x="><script>alert(1)</script>')).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
    );
  });

  it("the frame after the click sends the origin as Referer and stays sandboxed", () => {
    const html = renderToStaticMarkup(
      createElement(LessonVideoFrame, {
        src: lessonVideoSrc("https://youtu.be/dQw4w9WgXcQ")!,
        title: en.training.videoTitle,
      }),
    );
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"');
    expect(html).toContain('referrerPolicy="strict-origin-when-cross-origin"');
    expect(html).not.toContain("no-referrer");
    expect(html).toContain(
      'sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"',
    );
    expect(html).toContain('allow="autoplay; encrypted-media; picture-in-picture; fullscreen"');
    expect(html).toContain(`title="${en.training.videoTitle}"`);
  });

  it("labels the button in the UI language", async () => {
    state.locale = "de";
    const html = await render("https://youtu.be/dQw4w9WgXcQ");
    expect(html).toContain(de.training.videoPlay);
    expect(html).toContain(de.training.videoNotice);
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
      expect(lessonVideoSrc(url), String(url)).toBeNull();
      expect(await render(url), String(url)).toBe("");
    }
  });
});
