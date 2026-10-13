/**
 * The announcement form's department picker while the item needs
 * re-targeting (decision 06 §N9, D-PT01; staging rehearsal and Codex review
 * of batch 15). Two things are kept apart:
 *   - the restricted state as it stands is shown, not offered: while no
 *     department is chosen and the author has not picked anything yet, the
 *     picker holds a value no option has, so its trigger shows the
 *     placeholder ("Restricted: needs a new audience");
 *   - the selectable empty choice stays "Everyone", and choosing it from a
 *     restricted item (with no team left) only says that it needs the
 *     confirmation. The save refuses it without the confirmation too
 *     (payload.ts `confirmAudience`, checked against the cms in save.ts).
 * Once the author confirms the audience, the picker is plain again.
 */

/** A value no option has: the picker shows its placeholder. */
export const RESTRICTED_VALUE = "__restricted__";

export interface DepartmentPickerInput {
  /** The cms says the item needs re-targeting. */
  needsRetarget: boolean;
  /** The author ticked "Confirm this audience when saving". */
  confirmed: boolean;
  /** The author chose something in the picker since the form loaded. */
  picked: boolean;
  /** The form's department ("" = none). */
  department: string;
  /** The form's team ("" = none). */
  team: string;
}

export interface DepartmentPickerState {
  /** The picker's value (RESTRICTED_VALUE: none of its options). */
  value: string;
  /** Show the restricted placeholder in the trigger. */
  placeholder: boolean;
  /** The hint under the picker (a manage.common.targeting key), or null. */
  hint: "restrictedHint" | "everyoneNeedsConfirm" | null;
}

export function departmentPicker(input: DepartmentPickerInput): DepartmentPickerState {
  const plain = { value: input.department, placeholder: false, hint: null };
  if (!input.needsRetarget || input.confirmed) return plain;
  if (input.department === "" && !input.picked) {
    return { value: RESTRICTED_VALUE, placeholder: true, hint: "restrictedHint" };
  }
  if (input.department === "" && input.team === "") {
    return { value: "", placeholder: false, hint: "everyoneNeedsConfirm" };
  }
  return plain;
}
