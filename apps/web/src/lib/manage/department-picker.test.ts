import { describe, expect, it } from "vitest";
import { RESTRICTED_VALUE, departmentPicker } from "./department-picker";

/**
 * The announcement form's department picker on an item that needs
 * re-targeting (Codex review of batch 15): the restricted state is shown,
 * never offered; the selectable empty choice stays "Everyone" and asks for
 * the confirmation; a confirmed audience makes the picker plain again.
 */
const ENG = "deptengineering000000000";
const TEAM = "teamplatform000000000000";
const base = { needsRetarget: true, confirmed: false, picked: false, department: "", team: "" };

describe("departmentPicker", () => {
  it("shows the restricted state as a value no option has until the author picks", () => {
    expect(departmentPicker(base)).toEqual({
      value: RESTRICTED_VALUE,
      placeholder: true,
      hint: "restrictedHint",
    });
    // A deleted department next to a surviving team: still restricted, shown.
    expect(departmentPicker({ ...base, team: TEAM })).toMatchObject({ placeholder: true });
  });

  it("choosing Everyone shows Everyone and asks for the confirmation (it would widen)", () => {
    expect(departmentPicker({ ...base, picked: true })).toEqual({
      value: "",
      placeholder: false,
      hint: "everyoneNeedsConfirm",
    });
    // A surviving department, then Everyone chosen (the Codex scenario).
    expect(departmentPicker({ ...base, picked: true, department: "" })).toMatchObject({
      hint: "everyoneNeedsConfirm",
    });
    // With a team left, Everyone for the department does not widen to all.
    expect(departmentPicker({ ...base, picked: true, team: TEAM }).hint).toBeNull();
  });

  it("is plain for a chosen department, a confirmed audience, or an item that needs nothing", () => {
    expect(departmentPicker({ ...base, department: ENG })).toEqual({
      value: ENG,
      placeholder: false,
      hint: null,
    });
    expect(departmentPicker({ ...base, confirmed: true })).toEqual({
      value: "",
      placeholder: false,
      hint: null,
    });
    expect(departmentPicker({ ...base, needsRetarget: false })).toEqual({
      value: "",
      placeholder: false,
      hint: null,
    });
  });
});
