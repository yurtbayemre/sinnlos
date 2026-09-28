import { describe, expect, it } from "vitest";

import { renderDigest, totalItems } from "./render-digest";

const CONTENT = {
  announcements: [{ title: "All-hands Freitag", author: "Maria" }],
  mentions: [{ title: "Sam commented on your post" }],
  kudos: [{ message: "Danke!", from: "Alex", value: "teamwork" }],
};

describe("renderDigest", () => {
  it("counts items and localizes by user locale", () => {
    expect(totalItems(CONTENT)).toBe(3);
    const de = renderDigest(CONTENT, { displayName: "Casey", locale: "de", baseUrl: "https://x" });
    expect(de.subject).toContain("3 Neuigkeiten");
    expect(de.text).toContain("Hallo Casey,");
    expect(de.text).toContain("Kudos für dich");
    const en = renderDigest(CONTENT, { displayName: "Casey", locale: "en", baseUrl: "https://x" });
    expect(en.subject).toContain("3 updates");
    expect(en.text).toContain("Mentions & replies");
  });

  it("omits empty sections and links the unsubscribe path", () => {
    const only = renderDigest(
      { announcements: [], mentions: [], kudos: CONTENT.kudos },
      { displayName: "C", locale: "en", baseUrl: "https://intranet.example" },
    );
    expect(only.text).not.toContain("Announcements");
    expect(only.text).toContain("Kudos for you");
    expect(only.text).toContain("https://intranet.example/profile");
  });

  it("summarises capped announcements as '+N more' and counts them (FX48)", () => {
    const capped = {
      announcements: [{ title: "Newest", author: null }],
      announcementsMore: 3,
      mentions: [],
      kudos: [],
    };
    expect(totalItems(capped)).toBe(4);
    const en = renderDigest(capped, { displayName: "C", locale: "en", baseUrl: "https://x" });
    expect(en.subject).toContain("4 updates");
    expect(en.text).toContain("• Newest\n• +3 more");
    expect(en.html).toContain("<li>+3 more</li>");
    const de = renderDigest(capped, { displayName: "C", locale: "de", baseUrl: "https://x" });
    expect(de.text).toContain("• +3 weitere");
  });

  it("ignores a zero, negative or fractional '+N more'", () => {
    for (const announcementsMore of [0, -2, 1.5, Number.NaN]) {
      const content = {
        announcements: [{ title: "Only", author: null }],
        announcementsMore,
        mentions: [],
        kudos: [],
      };
      expect(totalItems(content)).toBe(1);
      expect(renderDigest(content, { displayName: "C", baseUrl: "https://x" }).text).not.toContain(
        "more",
      );
    }
  });

  it("escapes HTML in user-generated content", () => {
    const evil = renderDigest(
      {
        announcements: [{ title: '<script>alert("x")</script>', author: null }],
        mentions: [],
        kudos: [],
      },
      { displayName: "C", locale: "en", baseUrl: "https://x" },
    );
    expect(evil.html).not.toContain("<script>");
    expect(evil.html).toContain("&lt;script&gt;");
  });
});
