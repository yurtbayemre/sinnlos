import { describe, expect, it } from "vitest";
import {
  audienceDocumentIds,
  canSeePoll,
  isInPollAudience,
  isPollTargeted,
  type PollTargeting,
  type PollViewer,
} from "./poll-audience";

/**
 * Poll targeting rules (decision 02): company-wide polls for every signed-in
 * role, targeted polls for the members of their departments only, compared
 * by documentId; admin_role/editor see everything but vote only in the
 * audience; "flag OR links" keeps a poll restricted after its links vanish.
 */

const ENG = "d-eng";
const DESIGN = "d-design";

const viewer = (roleType: string | null | undefined, departmentDocumentId: string | null): PollViewer => ({
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
        departments: [{ documentId: ENG }, { documentId: "" }, { documentId: null }, null, {}, { documentId: DESIGN }],
      }),
    ).toEqual([ENG, DESIGN]);
  });
});

describe("company-wide poll", () => {
  it("takes every signed-in viewer, with or without a department", () => {
    for (const poll of companyWide) {
      for (const v of [
        member(ENG),
        viewer("guest", DESIGN),
        viewer("authenticated", null),
        member(null),
        viewer("admin_role", null),
      ]) {
        expect(isInPollAudience(poll, v), `${JSON.stringify(poll)} ${v.roleType}`).toBe(true);
        expect(canSeePoll(poll, v)).toBe(true);
      }
    }
  });

  it("takes nobody without a signed-in user", () => {
    for (const poll of companyWide) {
      expect(isInPollAudience(poll, null)).toBe(false);
      expect(canSeePoll(poll, null)).toBe(false);
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

  it("takes a guest in a listed department like any member", () => {
    expect(isInPollAudience(engOnly, viewer("guest", ENG))).toBe(true);
    expect(canSeePoll(engOnly, viewer("guest", ENG))).toBe(true);
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
      expect(canSeePoll(engOnly, viewer(role, null)), role).toBe(true);
      expect(isInPollAudience(engOnly, viewer(role, ENG)), role).toBe(true);
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
