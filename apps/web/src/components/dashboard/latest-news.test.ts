import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import type { AnnouncementListItem } from "@/lib/api/announcements";

/**
 * The dashboard's news grid at phone width: below `lg` it has one column,
 * and that column is `grid-cols-1` (minmax(0, 1fr)), not the implicit auto
 * track. An auto track grows to its items' min-content, and a compact card's
 * title is one truncated line, so a long title made the dashboard wider
 * than a 360 px phone (the demo's news: 379 px, the page scrolled
 * sideways). From `lg` up the five columns are as before.
 */
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: "dashboard" | "common" | "relativeTime") => (key: string) =>
    (en[namespace] as Record<string, string>)[key] ?? key,
}));

const { LatestNews } = await import("./latest-news");

function item(id: number, title: string, pinned = false): AnnouncementListItem {
  return {
    id,
    documentId: `ann-${id}`,
    title,
    body: "Body",
    pinned,
    createdAt: "2026-10-01T08:00:00.000Z",
    author: { id: 3, username: "ada", displayName: "Ada Lovelace" },
  };
}

describe("LatestNews grid", () => {
  it("sizes its one phone column to the screen, not to the longest title", async () => {
    const html = renderToStaticMarkup(
      await LatestNews({
        news: {
          featured: item(1, "Q2 All-hands this Friday", true),
          rest: [item(2, "Office closed Mon 2026-05-01 for the public holiday, remote as usual")],
          failed: false,
        },
      }),
    );
    const grid = /<div class="(grid [^"]+)">/.exec(html)?.[1].split(" ") ?? [];
    expect(grid).toEqual(expect.arrayContaining(["grid", "grid-cols-1", "lg:grid-cols-5"]));
    // The compact title still truncates inside its card.
    expect(html).toMatch(/<div class="truncate [^"]*">Office closed Mon 2026-05-01/);
  });
});
