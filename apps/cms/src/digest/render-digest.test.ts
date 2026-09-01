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
