import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AnnouncementListItem } from "@/lib/api/announcements";
import { AnnouncementCard } from "./announcement-card";

/**
 * UI08: one AnnouncementCard for /announcements ("full") and the dashboard's
 * LatestNews ("featured", "compact"), on the lib/api type. Rendered with
 * react-dom/server.
 */
const item: AnnouncementListItem = {
  id: 7,
  documentId: "ann-7",
  title: "Kantine",
  body: "**Neu:** die [Speisekarte](https://example.test/menu)",
  pinned: true,
  createdAt: "2026-10-01T08:00:00.000Z",
  author: { id: 3, username: "ada", displayName: "", jobTitle: "Kitchen" },
};

const render = (props: Parameters<typeof AnnouncementCard>[0]) =>
  renderToStaticMarkup(createElement(AnnouncementCard, props));

describe("AnnouncementCard", () => {
  it("full: the h3 title, the Markdown body, the author by displayNameOf, ack and children", () => {
    const html = render({
      variant: "full",
      item,
      highlighted: true,
      dateLabel: "1 October 2026",
      unknownLabel: "Unknown",
      ack: createElement("button", null, "Confirm"),
      children: createElement("p", null, "comments"),
    });
    expect(html).toMatch(/<h3[^>]*>.*Kantine<\/h3>/);
    expect(html).toContain("<strong>Neu:</strong>");
    // An empty display name falls back to the username.
    expect(html).toContain(">ada<");
    expect(html).toContain("Kitchen");
    expect(html).toContain("1 October 2026");
    expect(html).toContain("border-primary/30");
    expect(html).toContain("<button>Confirm</button>");
    expect(html).toContain("<p>comments</p>");
    // The full card is no link (it holds the confirm button and comments).
    expect(html).not.toContain('href="/announcements"');
  });

  it("full: an unknown author reads as the fallback label, initials '?'", () => {
    const html = render({
      variant: "full",
      item: { ...item, author: null },
      dateLabel: null,
      unknownLabel: "Unknown",
    });
    expect(html).toContain(">Unknown<");
    expect(html).toContain(">?<");
    expect(html).not.toContain("border-primary/30");
  });

  it("featured: one link to /announcements, the badge, a plain-text excerpt", () => {
    const html = render({
      variant: "featured",
      item,
      badge: "Pinned",
      dateLabel: "2 days ago",
      unknownLabel: "Unknown",
    });
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/announcements"');
    expect(html).toContain("Pinned");
    expect(html).toContain("· 2 days ago");
    expect(html).toContain("Neu: die Speisekarte");
    expect(html).not.toContain("example.test");
    expect(html).toMatch(/<h3[^>]*>Kantine<\/h3>/);
  });

  it("compact: a link with the pin mark, the excerpt and author · date", () => {
    const html = render({
      variant: "compact",
      item: { ...item, pinned: false },
      dateLabel: "yesterday",
      unknownLabel: "Unknown",
    });
    expect(html).toContain('href="/announcements"');
    expect(html).not.toContain("<h3");
    expect(html).toContain("Neu: die Speisekarte");
    expect(html).toContain("<span>ada</span>");
    expect(html).toContain("<span>yesterday</span>");
    expect(html).not.toContain("bg-primary/10 text-primary");
  });
});
