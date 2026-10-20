import { describe, expect, it } from "vitest";
import { notificationTitle } from "./notification-title.js";

describe("notificationTitle", () => {
  it("renders every type in German and English", () => {
    const params = { actor: "Ada", subject: "Sommerfest" };
    expect(notificationTitle("announcement", params, "de")).toBe("Neuigkeit: Sommerfest");
    expect(notificationTitle("announcement", params, "en")).toBe("New announcement: Sommerfest");
    expect(notificationTitle("event", params, "de")).toBe("Neuer Termin: Sommerfest");
    expect(notificationTitle("kudos", params, "de")).toBe("Ada hat Ihnen Kudos gegeben!");
    expect(notificationTitle("kudos", params, "en")).toBe("Ada gave you kudos!");
    expect(notificationTitle("comment", params, "de")).toBe("Ada hat „Sommerfest“ kommentiert");
    expect(notificationTitle("comment", params, "en")).toBe('Ada commented on "Sommerfest"');
    const course = { subject: "Staplerunterweisung" };
    expect(notificationTitle("trainingDue", course, "de")).toBe(
      "Unterweisung „Staplerunterweisung“ läuft bald ab",
    );
    expect(notificationTitle("trainingDue", course, "en")).toBe(
      'Training "Staplerunterweisung" is due soon',
    );
    expect(notificationTitle("trainingExpired", course, "de")).toBe(
      "Unterweisung „Staplerunterweisung“ ist abgelaufen, bitte wiederholen",
    );
    expect(notificationTitle("trainingExpired", {}, "en")).toBe(
      'Training "a course" has expired, please repeat it',
    );
  });

  it("uses the fallback for a blank or missing value, and English for any other locale", () => {
    expect(notificationTitle("comment", { subject: "  " }, "fr")).toBe(
      'Someone commented on "an announcement"',
    );
    expect(notificationTitle("event", {}, "de")).toBe("Neuer Termin: Ohne Titel");
  });

  it("is null without stored values or for an unknown type (the caller shows the stored title)", () => {
    expect(notificationTitle("event", null, "de")).toBeNull();
    expect(notificationTitle("event", undefined, "de")).toBeNull();
    expect(notificationTitle("poll", {}, "de")).toBeNull();
    expect(notificationTitle("toString", {}, "en")).toBeNull();
  });
});
