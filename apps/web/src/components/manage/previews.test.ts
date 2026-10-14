import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AnnouncementEditable, EventEditable } from "@sinnlos/domain";
import { AnnouncementPreview, EventPreview } from "./previews";
import { MESSAGES, render } from "./render.test.helper";

/**
 * The /manage previews name the real author (batch 16 plan S13, K18):
 * `editable.authorName` is the announcement's author and the event's
 * organizer; "Unknown" only where the cms names nobody (a cms before batch
 * 16 sends no authorName, an item from the admin panel null).
 */
const base = {
  documentId: "annc00000000000000000001",
  version: "4",
  status: "published" as const,
  publishedAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-12T08:00:00.000Z",
  roleClass: "moderator" as const,
};

const announcement = (patch: Partial<AnnouncementEditable> = {}): AnnouncementEditable => ({
  ...base,
  title: "Canteen closed",
  body: "On Friday.",
  expiresAt: null,
  department: null,
  team: null,
  audienceRoles: [],
  ownerDepartment: null,
  needsRetarget: false,
  ...patch,
});

const event = (patch: Partial<EventEditable> = {}): EventEditable => ({
  ...base,
  title: "Town hall",
  description: null,
  start: "2026-11-02T09:00:00.000Z",
  end: null,
  allDay: false,
  location: "Atrium",
  url: null,
  rsvpEnabled: false,
  capacity: null,
  departments: [],
  ownerDepartment: null,
  needsRetarget: false,
  ...patch,
});

describe("the previews' author (S13)", () => {
  it("an announcement shows its author's name", () => {
    const html = render(
      createElement(AnnouncementPreview, {
        editable: announcement({ authorName: "Grace Hopper" }),
      }),
    );
    expect(html).toContain("Grace Hopper");
    expect(html).not.toContain(MESSAGES.en.manage.common.preview.unknownAuthor);
  });

  it("falls back to Unknown without a name (null, or a cms before batch 16)", () => {
    for (const patch of [{ authorName: null }, {}]) {
      const html = render(createElement(AnnouncementPreview, { editable: announcement(patch) }));
      expect(html).toContain(MESSAGES.en.manage.common.preview.unknownAuthor);
    }
  });

  it("an event shows its organizer", () => {
    const html = render(
      createElement(EventPreview, {
        editable: event({ authorName: "Grace Hopper" }),
        timeZone: "Europe/Berlin",
      }),
    );
    expect(html).toContain("Organized by Grace Hopper");
    const without = render(
      createElement(EventPreview, { editable: event(), timeZone: "Europe/Berlin" }),
    );
    expect(without).not.toContain("Organized by");
  });
});
