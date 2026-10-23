import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  AnnouncementEditable,
  EventEditable,
  PollEditable,
  QuickLinkEditable,
} from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { isChecked, isDisabled, MESSAGES, render, tagById } from "./render.test.helper";

/**
 * The area editors of /manage, server-rendered (decision 06 §L4, §N2, §N4;
 * batch 15 plan 15C "the department-author forms"): a department author's
 * form shows their department read-only and never a moderator-only field,
 * the team picker lists only their department's teams, the event says it
 * is visible to everyone and notifies the department; a moderator gets the
 * full form; a voted poll locks its answers; a create whose pickers could
 * not load cannot be saved. The Server Actions and the router are stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/manage/announcement-actions", () => ({
  saveAnnouncement: vi.fn(),
  publishAnnouncement: vi.fn(),
  unpublishAnnouncement: vi.fn(),
  discardAnnouncement: vi.fn(),
  deleteAnnouncement: vi.fn(),
}));
vi.mock("@/lib/manage/event-actions", () => ({
  saveEvent: vi.fn(),
  publishEvent: vi.fn(),
  unpublishEvent: vi.fn(),
  discardEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock("@/lib/manage/quick-link-actions", () => ({
  saveQuickLink: vi.fn(),
  publishQuickLink: vi.fn(),
  unpublishQuickLink: vi.fn(),
  discardQuickLink: vi.fn(),
  deleteQuickLink: vi.fn(),
}));
vi.mock("@/lib/manage/poll-actions", () => ({
  savePoll: vi.fn(),
  closePoll: vi.fn(),
  deletePoll: vi.fn(),
}));

const { AnnouncementEditor } = await import("./announcement-editor");
const { EventEditor } = await import("./event-editor");
const { PollEditor } = await import("./poll-editor");
const { QuickLinkEditor } = await import("./quick-link-editor");

const t = MESSAGES.en.manage;
const ENG = { documentId: "deptengineering000000000", name: "Engineering" };
const SALES = { documentId: "deptsales000000000000000", name: "Sales" };
const TEAMS = [
  { documentId: "teamplatform000000000000", name: "Platform", department: ENG.documentId },
  { documentId: "teamfield000000000000000", name: "Field sales", department: SALES.documentId },
];
const MODERATOR: Omit<AreaAccess, "area"> = {
  verbs: ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"],
  scope: "any",
  roleClass: "moderator",
};
const AUTHOR: Omit<AreaAccess, "area"> = {
  verbs: ["create", "edit", "publish", "unpublish", "discard"],
  scope: "ownDepartment",
  roleClass: "departmentAuthor",
};
const base = {
  documentId: "annc00000000000000000001",
  version: "4",
  status: "modified" as const,
  publishedAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-12T08:00:00.000Z",
};

describe("AnnouncementEditor", () => {
  const props = {
    timeZone: "Europe/Berlin",
    departments: [ENG, SALES],
    teams: TEAMS,
    optionsFailed: false,
    optionsTruncated: false,
  };

  it("a moderator's create: every field, the department picker, the confirmation section", () => {
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        editable: null,
        access: { ...MODERATOR, area: "announcements" },
        ownDepartment: null,
      }),
    );
    for (const id of [
      "announcement-title",
      "announcement-body",
      "announcement-pinned",
      "announcement-expiresAt",
      "announcement-expiresAt-time",
      "announcement-department",
      "announcement-team",
      "announcement-audienceRoles",
      "announcement-requiresAck",
      "announcement-ackDeadline",
    ]) {
      expect(tagById(html, id), id).not.toBe("");
    }
    expect(html).toContain(t.announcements.sections.confirmation);
    // The deadline waits for the confirmation.
    expect(isDisabled(tagById(html, "announcement-ackDeadline"))).toBe(true);
    expect(html).toContain(t.common.actions.schedule);
  });

  it("a department author's form: the department read-only, no pinned, ack or schedule (§N2, §N4)", () => {
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        departments: [],
        teams: TEAMS.filter((team) => team.department === ENG.documentId),
        editable: null,
        access: { ...AUTHOR, area: "announcements" },
        ownDepartment: ENG,
      }),
    );
    expect(html).toContain(t.common.departmentAuthor.department);
    expect(html).toContain(">Engineering</dd>");
    expect(html).toContain(t.common.departmentAuthor.departmentHint);
    for (const id of [
      "announcement-pinned",
      "announcement-requiresAck",
      "announcement-ackDeadline",
      "announcement-department",
    ]) {
      expect(tagById(html, id), id).toBe("");
    }
    expect(html).not.toContain(t.announcements.sections.confirmation);
    expect(html).not.toContain(t.common.actions.schedule);
    expect(html).not.toContain(`>${t.common.actions.delete}</button>`);
    // Staff role types only: guests cannot read announcements.
    expect(html).not.toContain(`>${t.common.targeting.roles.guest}</label>`);
    expect(html).toContain(`>${t.common.targeting.roles.member}</label>`);
  });

  it("an edit shows the status and, for moderators, the owner department; Discard with a published version", () => {
    const editable: AnnouncementEditable = {
      ...base,
      roleClass: "moderator",
      title: "Canteen",
      body: "Closed",
      expiresAt: null,
      department: ENG.documentId,
      team: null,
      audienceRoles: [],
      ownerDepartment: ENG,
      needsRetarget: true,
      pinned: false,
      requiresAck: false,
      ackDeadline: null,
      publishAt: null,
      scheduleError: null,
    };
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        editable,
        access: { ...MODERATOR, area: "announcements" },
        ownDepartment: null,
      }),
    );
    expect(html).toContain(t.common.status.modified);
    expect(html).toContain("Department: Engineering");
    expect(html).toContain(t.common.status.needsRetarget);
    expect(html).toContain(t.common.targeting.retargetConfirm);
    expect(html).toContain(t.common.actions.discard);
    expect(html).toContain(t.common.actions.unpublish);
    expect(tagById(html, "announcement-title")).toContain('value="Canteen"');
  });

  it("a D-PT01 announcement (no department or team): its own notice, and the picker reads Restricted, not Everyone", () => {
    // Staging rehearsal: the notice spoke of a deleted department that never
    // existed, and the picker showed "Everyone" for a restricted item.
    const editable: AnnouncementEditable = {
      ...base,
      roleClass: "moderator",
      title: "Legacy",
      body: null,
      expiresAt: null,
      department: null,
      team: null,
      audienceRoles: [],
      ownerDepartment: null,
      needsRetarget: true,
      pinned: false,
      requiresAck: false,
      ackDeadline: null,
      publishAt: null,
      scheduleError: null,
    };
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        editable,
        access: { ...MODERATOR, area: "announcements" },
        ownDepartment: null,
      }),
    );
    expect(html).toContain(t.common.targeting.retargetNoTarget);
    expect(html).not.toContain(t.common.targeting.retargetNotice);
    const trigger =
      /<button[^>]*aria-describedby="announcement-department-hint"[^>]*>[\s\S]*?<\/button>/.exec(
        html,
      )?.[0] ?? "";
    expect(trigger).toContain(t.common.targeting.restricted);
    expect(trigger).not.toContain(`>${t.common.targeting.everyone}<`);
    expect(html).toContain(t.common.targeting.restrictedHint);
  });

  it("a marked announcement whose team remains says a target was deleted", () => {
    const editable: AnnouncementEditable = {
      ...base,
      roleClass: "moderator",
      title: "Team news",
      body: null,
      expiresAt: null,
      department: null,
      team: TEAMS[0].documentId,
      audienceRoles: [],
      ownerDepartment: null,
      needsRetarget: true,
      pinned: false,
      requiresAck: false,
      ackDeadline: null,
      publishAt: null,
      scheduleError: null,
    };
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        editable,
        access: { ...MODERATOR, area: "announcements" },
        ownDepartment: null,
      }),
    );
    expect(html).toContain(t.common.targeting.retargetNotice);
    expect(html).not.toContain(t.common.targeting.retargetNoTarget);
  });

  it("a department author's never-published draft offers no Discard", () => {
    const editable: AnnouncementEditable = {
      ...base,
      status: "draft",
      publishedAt: null,
      roleClass: "departmentAuthor",
      title: "Draft",
      body: null,
      expiresAt: null,
      department: ENG.documentId,
      team: null,
      audienceRoles: [],
      ownerDepartment: ENG,
      needsRetarget: false,
    };
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        editable,
        access: { ...AUTHOR, area: "announcements" },
        ownDepartment: ENG,
      }),
    );
    expect(html).not.toContain(t.common.actions.discard);
    expect(html).not.toContain(t.common.actions.unpublish);
  });

  it("a create whose pickers failed says so and cannot be saved (fail closed)", () => {
    const html = render(
      createElement(AnnouncementEditor, {
        ...props,
        departments: [],
        teams: [],
        optionsFailed: true,
        editable: null,
        access: { ...MODERATOR, area: "announcements" },
        ownDepartment: null,
      }),
    );
    expect(html).toContain(t.common.targeting.optionsFailed);
    const save =
      html.match(new RegExp(`<button[^>]*>${t.common.actions.saveDraft}</button>`))?.[0] ?? "";
    expect(isDisabled(save)).toBe(true);
  });
});

describe("EventEditor", () => {
  const editable: EventEditable = {
    ...base,
    documentId: "evnt00000000000000000001",
    roleClass: "departmentAuthor",
    title: "Offsite",
    description: null,
    start: "2026-11-03T09:00:00.000Z",
    end: null,
    allDay: false,
    location: null,
    url: null,
    rsvpEnabled: true,
    capacity: 10,
    departments: [ENG.documentId],
    ownerDepartment: ENG,
    needsRetarget: false,
  };

  it("a department author's event: pinned department, the calendar note, no schedule", () => {
    const html = render(
      createElement(EventEditor, {
        editable,
        access: { ...AUTHOR, area: "events" },
        timeZone: "Europe/Berlin",
        departments: [],
        optionsFailed: false,
        optionsTruncated: false,
        ownDepartment: ENG,
        yesCount: null,
      }),
    );
    expect(html).toContain(t.common.departmentAuthor.eventVisibility);
    expect(html).toContain(">Engineering</dd>");
    expect(tagById(html, "event-departments")).toBe("");
    expect(html).not.toContain(t.common.actions.schedule);
    expect(tagById(html, "event-start")).toContain('value="2026-11-03"');
    expect(tagById(html, "event-start-time")).toContain('value="10:00"');
  });

  it("warns when the capacity is below the people who accepted", () => {
    const html = render(
      createElement(EventEditor, {
        editable,
        access: { ...MODERATOR, area: "events" },
        timeZone: "Europe/Berlin",
        departments: [ENG, SALES],
        optionsFailed: false,
        optionsTruncated: false,
        ownDepartment: null,
        yesCount: 12,
      }),
    );
    expect(html).toContain("12 people have already accepted; nobody is removed.");
    expect(html).toContain(t.events.fields.departments.label);
    expect(isChecked(tagById(html, "event-departments"))).toBe(true);
  });

  it("an all-day event shows day fields", () => {
    const html = render(
      createElement(EventEditor, {
        editable: {
          ...editable,
          allDay: true,
          start: "2026-10-23T22:00:00.000Z",
          end: "2026-10-25T23:00:00.000Z",
        },
        access: { ...MODERATOR, area: "events" },
        timeZone: "Europe/Berlin",
        departments: [],
        optionsFailed: false,
        optionsTruncated: false,
        ownDepartment: null,
        yesCount: null,
      }),
    );
    expect(tagById(html, "event-start")).toContain('value="2026-10-24"');
    expect(tagById(html, "event-end")).toContain('value="2026-10-26"');
    expect(tagById(html, "event-start-time")).toBe("");
  });
});

describe("QuickLinkEditor", () => {
  it("offers the shared icon keys and the categories", () => {
    const editable: QuickLinkEditable = {
      ...base,
      documentId: "qlnk00000000000000000001",
      roleClass: "moderator",
      label: "HR portal",
      url: "https://hr.example",
      icon: "Briefcase",
      category: "hr",
      order: 3,
      departments: [],
      needsRetarget: false,
      publishAt: "2026-11-01T07:00:00.000Z",
      unpublishAt: "2026-12-01T07:00:00.000Z",
      scheduleError: null,
    };
    const html = render(
      createElement(QuickLinkEditor, {
        editable,
        access: { ...MODERATOR, area: "quickLinks" },
        timeZone: "Europe/Berlin",
        departments: [ENG],
        optionsFailed: false,
        optionsTruncated: false,
      }),
    );
    expect(tagById(html, "quick-link-url")).toContain('value="https://hr.example"');
    expect(html).toContain("Briefcase");
    // The trigger shows the chosen category (HTML-escaped).
    expect(html).toContain(MESSAGES.en.quickLinks.categories.hr.replace("&", "&amp;"));
    expect(html).toContain("Publishes on");
    expect(html).toContain("Withdraws on");
  });
});

describe("PollEditor", () => {
  const poll: PollEditable = {
    ...base,
    documentId: "poll00000000000000000001",
    status: "published",
    roleClass: "moderator",
    question: "Lunch?",
    options: ["Pizza", "Salad"],
    closesAt: null,
    anonymous: false,
    departments: [],
    visibleToGuests: false,
    guestsCanVote: false,
    needsRetarget: false,
    hasVotes: true,
  };
  const props = {
    access: {
      area: "polls" as const,
      verbs: ["create", "edit", "delete"] as const,
      scope: "any" as const,
      roleClass: "moderator" as const,
    },
    timeZone: "Europe/Berlin",
    today: "2026-10-13",
    closed: false,
    departments: [ENG],
    optionsFailed: false,
    optionsTruncated: false,
  };

  it("locks the answers and the anonymity once someone voted", () => {
    const html = render(
      createElement(PollEditor, {
        ...props,
        access: { ...props.access, verbs: [...props.access.verbs] },
        editable: poll,
      }),
    );
    expect(isDisabled(tagById(html, "poll-options"))).toBe(true);
    expect(isDisabled(tagById(html, "poll-anonymous"))).toBe(true);
    expect(html).toContain(t.polls.fields.options.frozen);
    expect(html).not.toContain(t.polls.fields.options.add);
    expect(html).toContain(t.common.actions.closeNow);
  });

  it("locks the end date once the voter links are removed (v0.28)", () => {
    const render_ = (votersRemoved: boolean) =>
      render(
        createElement(PollEditor, {
          ...props,
          access: { ...props.access, verbs: [...props.access.verbs] },
          editable: { ...poll, closesAt: "2026-08-31T22:00:00.000Z", votersRemoved },
          closed: true,
        }),
      );
    expect(isDisabled(tagById(render_(true), "poll-closesAt"))).toBe(true);
    expect(render_(true)).toContain(t.common.errors.votersRemoved);
    expect(isDisabled(tagById(render_(false), "poll-closesAt"))).toBe(false);
  });

  it("a new poll: two answers of at most 200 characters, closing days from today, guest voting off", () => {
    const html = render(
      createElement(PollEditor, {
        ...props,
        access: { ...props.access, verbs: [...props.access.verbs] },
        editable: null,
      }),
    );
    expect(tagById(html, "poll-options")).toContain('maxLength="200"');
    expect(tagById(html, "poll-options-1")).not.toBe("");
    expect(html).toContain("2 to 20 answers, each up to 200 characters.");
    expect(tagById(html, "poll-closesAt")).toContain('min="2026-10-13"');
    expect(isDisabled(tagById(html, "poll-guestsCanVote"))).toBe(true);
    expect(html).toContain(`>${t.common.actions.create}</button>`);
    expect(html).not.toContain(t.common.actions.closeNow);
  });
});
