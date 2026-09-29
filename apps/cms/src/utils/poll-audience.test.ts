import { describe, expect, it } from "vitest";
import {
  audienceDocumentIds,
  canGuestsVoteOnPoll,
  canSeePoll,
  canVoteOnPoll,
  isGuestViewer,
  isInPollAudience,
  isPollTargeted,
  isPollVisibleToGuests,
  type PollTargeting,
  type PollViewer,
} from "./poll-audience";

/**
 * Poll targeting rules (decision 02): company-wide polls for every signed-in
 * role, targeted polls for the members of their departments only, compared
 * by documentId; admin_role/editor see everything but vote only in the
 * audience; "flag OR links" keeps a poll restricted after its links vanish.
 * Guest access (owner decision 2026-09-27): a guest sees a poll only when
 * it is visibleToGuests AND the audience takes the guest, and votes only
 * when guestsCanVote is on as well; NULL flags are "no".
 */

const ENG = "d-eng";
const DESIGN = "d-design";

const viewer = (
  roleType: string | null | undefined,
  departmentDocumentId: string | null,
): PollViewer => ({
  roleType,
  departmentDocumentId,
});

const member = (department: string | null) => viewer("member", department);

const companyWide: PollTargeting[] = [
  { audience: null, departments: [] },
  { audience: "all", departments: [] },
  { audience: undefined, departments: undefined },
  {},
];

const engOnly: PollTargeting = { audience: "departments", departments: [{ documentId: ENG }] };

describe("isPollTargeted", () => {
  it("is false only without a restricting flag AND without links", () => {
    for (const poll of companyWide) expect(isPollTargeted(poll), JSON.stringify(poll)).toBe(false);
  });

  it("is true for audience='departments', even with no department left (fail closed)", () => {
    expect(isPollTargeted({ audience: "departments", departments: [] })).toBe(true);
    expect(isPollTargeted({ audience: "departments" })).toBe(true);
  });

  it("is true when departments are linked although the flag says 'all'", () => {
    expect(isPollTargeted({ audience: "all", departments: [{ documentId: ENG }] })).toBe(true);
    expect(isPollTargeted({ audience: null, departments: [{ documentId: ENG }] })).toBe(true);
  });

  it("counts a link without a usable documentId as a link", () => {
    expect(isPollTargeted({ audience: "all", departments: [{ documentId: null }] })).toBe(true);
  });

  it("treats an unknown flag value as restricting", () => {
    expect(isPollTargeted({ audience: "everyone", departments: [] })).toBe(true);
  });
});

describe("audienceDocumentIds", () => {
  it("keeps non-empty string documentIds only", () => {
    expect(
      audienceDocumentIds({
        departments: [
          { documentId: ENG },
          { documentId: "" },
          { documentId: null },
          null,
          {},
          { documentId: DESIGN },
        ],
      }),
    ).toEqual([ENG, DESIGN]);
  });
});

describe("company-wide poll", () => {
  it("takes every signed-in viewer into its audience, with or without a department", () => {
    for (const poll of companyWide) {
      for (const v of [
        member(ENG),
        viewer("guest", DESIGN),
        viewer("authenticated", null),
        member(null),
        viewer("admin_role", null),
      ]) {
        expect(isInPollAudience(poll, v), `${JSON.stringify(poll)} ${v.roleType}`).toBe(true);
      }
    }
  });

  it("is seen and voted on by every signed-in non-guest", () => {
    for (const poll of companyWide) {
      for (const v of [
        member(ENG),
        viewer("authenticated", null),
        member(null),
        viewer("admin_role", null),
      ]) {
        expect(canSeePoll(poll, v), `${JSON.stringify(poll)} ${v.roleType}`).toBe(true);
        expect(canVoteOnPoll(poll, v), `${JSON.stringify(poll)} ${v.roleType}`).toBe(true);
      }
    }
  });

  it("is hidden from a guest while the guest flags are unset (the default)", () => {
    for (const poll of companyWide) {
      expect(canSeePoll(poll, viewer("guest", DESIGN)), JSON.stringify(poll)).toBe(false);
      expect(canVoteOnPoll(poll, viewer("guest", DESIGN)), JSON.stringify(poll)).toBe(false);
    }
  });

  it("takes nobody without a signed-in user", () => {
    for (const poll of companyWide) {
      expect(isInPollAudience(poll, null)).toBe(false);
      expect(canSeePoll(poll, null)).toBe(false);
      expect(canVoteOnPoll(poll, null)).toBe(false);
    }
  });
});

describe("targeted poll", () => {
  it("takes a member of a listed department (documentId match)", () => {
    expect(isInPollAudience(engOnly, member(ENG))).toBe(true);
    expect(canSeePoll(engOnly, member(ENG))).toBe(true);
  });

  it("refuses another department, no department and an empty documentId", () => {
    for (const v of [member(DESIGN), member(null), member("")]) {
      expect(isInPollAudience(engOnly, v), String(v.departmentDocumentId)).toBe(false);
      expect(canSeePoll(engOnly, v)).toBe(false);
    }
  });

  it("never matches a department entry whose documentId is missing", () => {
    const broken: PollTargeting = { audience: "departments", departments: [{ documentId: null }] };
    expect(isInPollAudience(broken, member(ENG))).toBe(false);
    expect(isInPollAudience(broken, member(""))).toBe(false);
  });

  it("OR-combines several departments", () => {
    const both: PollTargeting = {
      audience: "departments",
      departments: [{ documentId: ENG }, { documentId: DESIGN }],
    };
    expect(isInPollAudience(both, member(ENG))).toBe(true);
    expect(isInPollAudience(both, member(DESIGN))).toBe(true);
    expect(isInPollAudience(both, member("d-hr"))).toBe(false);
  });

  it("takes a guest in a listed department into its audience like any member", () => {
    expect(isInPollAudience(engOnly, viewer("guest", ENG))).toBe(true);
    // ... but guest access decides whether the guest sees it (see below).
    expect(canSeePoll(engOnly, viewer("guest", ENG))).toBe(false);
    expect(canSeePoll({ ...engOnly, visibleToGuests: true }, viewer("guest", ENG))).toBe(true);
  });

  it("gives role no membership of its own (heads, leads, the fallback role)", () => {
    for (const role of ["department_head", "team_lead", "authenticated", "guest"]) {
      expect(isInPollAudience(engOnly, viewer(role, DESIGN)), role).toBe(false);
      expect(canSeePoll(engOnly, viewer(role, DESIGN)), role).toBe(false);
    }
  });

  it("restricts a poll with links even when its flag says 'all'", () => {
    const legacy: PollTargeting = { audience: "all", departments: [{ documentId: ENG }] };
    expect(isInPollAudience(legacy, member(DESIGN))).toBe(false);
    expect(isInPollAudience(legacy, member(ENG))).toBe(true);
  });
});

describe("admin_role and editor", () => {
  it("see every targeted poll but vote only in its audience", () => {
    for (const role of ["admin_role", "editor"]) {
      expect(canSeePoll(engOnly, viewer(role, DESIGN)), role).toBe(true);
      expect(isInPollAudience(engOnly, viewer(role, DESIGN)), role).toBe(false);
      expect(canVoteOnPoll(engOnly, viewer(role, DESIGN)), role).toBe(false);
      expect(canSeePoll(engOnly, viewer(role, null)), role).toBe(true);
      expect(isInPollAudience(engOnly, viewer(role, ENG)), role).toBe(true);
      expect(canVoteOnPoll(engOnly, viewer(role, ENG)), role).toBe(true);
    }
  });

  it("alone see a poll flagged 'departments' with no department left", () => {
    const orphaned: PollTargeting = { audience: "departments", departments: [] };
    for (const role of ["admin_role", "editor"]) {
      expect(canSeePoll(orphaned, viewer(role, ENG)), role).toBe(true);
      expect(isInPollAudience(orphaned, viewer(role, ENG)), role).toBe(false);
    }
    for (const role of ["department_head", "team_lead", "member", "guest", "authenticated"]) {
      expect(canSeePoll(orphaned, viewer(role, ENG)), role).toBe(false);
    }
  });

  it("bypass only on an exact role match", () => {
    for (const role of ["Admin_role", "EDITOR", "admin", "", undefined, null]) {
      expect(canSeePoll(engOnly, viewer(role, DESIGN)), String(role)).toBe(false);
    }
  });
});

describe("guest access (owner decision 2026-09-27)", () => {
  const GUEST_IN_ENG = viewer("guest", ENG);
  const GUEST_IN_DESIGN = viewer("guest", DESIGN);
  const GUEST_WITHOUT_DEPARTMENT = viewer("guest", null);

  /** The three audience situations of a guest in Engineering. */
  const situations: { name: string; targeting: PollTargeting; inAudience: boolean }[] = [
    { name: "company-wide", targeting: { audience: "all", departments: [] }, inAudience: true },
    { name: "targeted, guest's department", targeting: engOnly, inAudience: true },
    {
      name: "targeted, other department",
      targeting: { audience: "departments", departments: [{ documentId: DESIGN }] },
      inAudience: false,
    },
  ];

  /** Every combination of the two flags, NULL and missing included. */
  const flagValues = [true, false, null, undefined] as const;

  it("sees a poll iff visibleToGuests is true AND the audience takes the guest", () => {
    for (const { name, targeting, inAudience } of situations) {
      for (const visibleToGuests of flagValues) {
        for (const guestsCanVote of flagValues) {
          const poll: PollTargeting = { ...targeting, visibleToGuests, guestsCanVote };
          const label = `${name} visible=${String(visibleToGuests)} vote=${String(guestsCanVote)}`;
          expect(canSeePoll(poll, GUEST_IN_ENG), label).toBe(
            inAudience && visibleToGuests === true,
          );
        }
      }
    }
  });

  it("votes iff it sees the poll AND guestsCanVote is true", () => {
    for (const { name, targeting, inAudience } of situations) {
      for (const visibleToGuests of flagValues) {
        for (const guestsCanVote of flagValues) {
          const poll: PollTargeting = { ...targeting, visibleToGuests, guestsCanVote };
          const label = `${name} visible=${String(visibleToGuests)} vote=${String(guestsCanVote)}`;
          expect(canVoteOnPoll(poll, GUEST_IN_ENG), label).toBe(
            inAudience && visibleToGuests === true && guestsCanVote === true,
          );
        }
      }
    }
  });

  it("treats guestsCanVote without visibleToGuests as inert (fail closed)", () => {
    for (const visibleToGuests of [false, null, undefined]) {
      const poll: PollTargeting = {
        audience: "all",
        departments: [],
        visibleToGuests,
        guestsCanVote: true,
      };
      expect(canSeePoll(poll, GUEST_IN_ENG), String(visibleToGuests)).toBe(false);
      expect(canVoteOnPoll(poll, GUEST_IN_ENG), String(visibleToGuests)).toBe(false);
      expect(canGuestsVoteOnPoll(poll), String(visibleToGuests)).toBe(false);
    }
  });

  it("accepts only a real true (no truthy stand-ins from a stray write)", () => {
    for (const truthy of [1, "true", "1", {}] as unknown[]) {
      const poll = {
        audience: "all",
        departments: [],
        visibleToGuests: truthy,
        guestsCanVote: truthy,
      } as PollTargeting;
      expect(isPollVisibleToGuests(poll), JSON.stringify(truthy)).toBe(false);
      expect(canSeePoll(poll, GUEST_IN_ENG), JSON.stringify(truthy)).toBe(false);
    }
  });

  it("keeps the department rule for a visible poll: out of the audience stays out", () => {
    const open: PollTargeting = { ...engOnly, visibleToGuests: true, guestsCanVote: true };
    expect(canSeePoll(open, GUEST_IN_ENG)).toBe(true);
    expect(canVoteOnPoll(open, GUEST_IN_ENG)).toBe(true);
    for (const v of [GUEST_IN_DESIGN, GUEST_WITHOUT_DEPARTMENT]) {
      expect(canSeePoll(open, v), String(v.departmentDocumentId)).toBe(false);
      expect(canVoteOnPoll(open, v), String(v.departmentDocumentId)).toBe(false);
    }
    const orphaned: PollTargeting = {
      audience: "departments",
      departments: [],
      visibleToGuests: true,
      guestsCanVote: true,
    };
    expect(canSeePoll(orphaned, GUEST_IN_ENG)).toBe(false);
  });

  it("lets a guest without a department see and vote on an opened company-wide poll", () => {
    const open: PollTargeting = {
      audience: "all",
      departments: [],
      visibleToGuests: true,
      guestsCanVote: true,
    };
    expect(canSeePoll(open, GUEST_WITHOUT_DEPARTMENT)).toBe(true);
    expect(canVoteOnPoll(open, GUEST_WITHOUT_DEPARTMENT)).toBe(true);
  });

  it("recognises a guest by the exact role type only", () => {
    expect(isGuestViewer(viewer("guest", null))).toBe(true);
    for (const role of [
      "Guest",
      "GUEST",
      "guests",
      " guest",
      "authenticated",
      "member",
      "",
      null,
      undefined,
    ]) {
      expect(isGuestViewer(viewer(role, null)), String(role)).toBe(false);
    }
    expect(isGuestViewer(null)).toBe(false);
  });

  it("does not change any other role: the flags neither hide nor open anything for them", () => {
    const hidden: PollTargeting = {
      audience: "all",
      departments: [],
      visibleToGuests: false,
      guestsCanVote: false,
    };
    const opened: PollTargeting = {
      audience: "all",
      departments: [],
      visibleToGuests: true,
      guestsCanVote: true,
    };
    for (const role of ["member", "department_head", "team_lead", "authenticated"]) {
      for (const poll of [hidden, opened, { audience: "all", departments: [] }]) {
        expect(canSeePoll(poll, viewer(role, null)), role).toBe(true);
        expect(canVoteOnPoll(poll, viewer(role, null)), role).toBe(true);
      }
      // A targeted poll stays closed to outsiders, opened for guests or not.
      expect(
        canSeePoll(
          { ...engOnly, visibleToGuests: true, guestsCanVote: true },
          viewer(role, DESIGN),
        ),
        role,
      ).toBe(false);
    }
  });

  it("does not change the admin_role/editor bypass: they see hidden polls, and vote only in the audience", () => {
    const hidden: PollTargeting = { ...engOnly, visibleToGuests: false, guestsCanVote: false };
    for (const role of ["admin_role", "editor"]) {
      expect(canSeePoll(hidden, viewer(role, DESIGN)), role).toBe(true);
      expect(canVoteOnPoll(hidden, viewer(role, DESIGN)), role).toBe(false);
      expect(canVoteOnPoll(hidden, viewer(role, ENG)), role).toBe(true);
      expect(canVoteOnPoll({ audience: "all", departments: [] }, viewer(role, null)), role).toBe(
        true,
      );
    }
  });
});
