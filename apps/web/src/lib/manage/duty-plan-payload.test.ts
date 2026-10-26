import { describe, expect, it } from "vitest";
import { buildDutyPlanPayload, type PayloadContext } from "./payload";
import { coerceDutyPlanValues, emptyDutyPlanValues, type DutyPlanValues } from "./values";

/**
 * The duty-plan payload (v0.18): templates and shifts are lists of objects,
 * so a change is found by comparing them as written; shifts that ended more
 * than four weeks ago leave the plan on every save; refusals carry the
 * shared rules' codes on their field.
 */
const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const ENG = "deptengineering000000000";

const ctx = (overrides: Partial<PayloadContext> = {}): PayloadContext => ({
  mode: "update",
  roleClass: "departmentAuthor",
  timeZone: "Europe/Berlin",
  now: NOW,
  ownDepartment: ENG,
  ...overrides,
});

const plan = (patch: Partial<DutyPlanValues> = {}): DutyPlanValues => ({
  ...emptyDutyPlanValues(ENG),
  name: "Schlüsseldienst",
  shiftTemplates: [{ label: "Früh", start: "06:00", end: "14:00" }],
  shifts: [{ userId: 7, startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-20T12:00:00.000Z" }],
  ...patch,
});

describe("buildDutyPlanPayload", () => {
  it("names a clock-change wall time kept as typed: timeSkipped or timeRepeated (#183)", () => {
    const at = (startsAt: string, endsAt: string) =>
      buildDutyPlanPayload(plan({ shifts: [{ userId: 7, startsAt, endsAt }] }), null, ctx());
    expect(at("2027-03-28T02:30", "2027-03-28T08:00:00.000Z")).toEqual({
      ok: false,
      fields: { shifts: "timeSkipped" },
    });
    expect(at("2026-10-25T05:00:00.000Z", "2026-10-25T02:30")).toEqual({
      ok: false,
      fields: { shifts: "timeRepeated" },
    });
    // Still being typed: the generic refusal, as before.
    expect(at("T06:00", "2026-10-25T13:00:00.000Z")).toEqual({
      ok: false,
      fields: { shifts: "invalid" },
    });
  });

  it("sends every field on create, the department pinned to the author's", () => {
    expect(buildDutyPlanPayload(plan(), null, ctx({ mode: "create" }))).toEqual({
      ok: true,
      data: {
        name: "Schlüsseldienst",
        note: null,
        department: ENG,
        shiftTemplates: [{ label: "Früh", start: "06:00", end: "14:00" }],
        shifts: [
          { userId: 7, startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-20T12:00:00.000Z" },
        ],
      },
    });
  });

  it("finds a changed shift by its content, and sends nothing for an untouched plan", () => {
    const initial = plan();
    expect(buildDutyPlanPayload(plan(), initial, ctx())).toEqual({ ok: true, data: {} });
    const moved = plan({
      shifts: [
        { userId: 8, startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-20T12:00:00.000Z" },
      ],
    });
    expect(buildDutyPlanPayload(moved, initial, ctx())).toEqual({
      ok: true,
      data: { shifts: moved.shifts },
    });
  });

  it("drops shifts that ended more than four weeks ago", () => {
    const old = {
      userId: 7,
      startsAt: "2026-09-01T04:00:00.000Z",
      endsAt: "2026-09-01T12:00:00.000Z",
    };
    const values = plan({ shifts: [old, ...plan().shifts] });
    const built = buildDutyPlanPayload(values, plan({ shifts: [] }), ctx());
    expect(built).toEqual({ ok: true, data: { shifts: plan().shifts } });
  });

  it("refuses a shift without a person or with its end before its start, on the field", () => {
    const noPerson = plan({
      shifts: [
        { userId: 0, startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-20T12:00:00.000Z" },
      ],
    });
    expect(buildDutyPlanPayload(noPerson, null, ctx({ mode: "create" }))).toEqual({
      ok: false,
      fields: { shifts: "invalid" },
    });
    const backwards = plan({
      shifts: [
        { userId: 7, startsAt: "2026-10-20T12:00:00.000Z", endsAt: "2026-10-20T04:00:00.000Z" },
      ],
    });
    expect(buildDutyPlanPayload(backwards, null, ctx({ mode: "create" }))).toEqual({
      ok: false,
      fields: { shifts: "endBeforeStart" },
    });
  });

  it("refuses a shift with an unreadable end instead of dropping it", () => {
    const cleared = plan({
      shifts: [{ userId: 7, startsAt: "2026-10-20T04:00:00.000Z", endsAt: "2026-10-20T" }],
    });
    expect(buildDutyPlanPayload(cleared, plan(), ctx())).toEqual({
      ok: false,
      fields: { shifts: "invalid" },
    });
  });

  it("prunes old shifts also when only the note changed", () => {
    const old = {
      userId: 7,
      startsAt: "2026-09-01T04:00:00.000Z",
      endsAt: "2026-09-01T12:00:00.000Z",
    };
    const initial = plan({ shifts: [old, ...plan().shifts] });
    const built = buildDutyPlanPayload({ ...initial, note: "Neu" }, initial, ctx());
    expect(built).toEqual({ ok: true, data: { note: "Neu", shifts: plan().shifts } });
  });

  it("keeps an overlong list for the rules to refuse", () => {
    const shift = plan().shifts[0]!;
    const values = coerceDutyPlanValues({ name: "X", shifts: Array(401).fill(shift) });
    expect(values.shifts).toHaveLength(401);
    expect(buildDutyPlanPayload(values, null, ctx({ mode: "create" }))).toMatchObject({
      ok: false,
      fields: { shifts: "invalid" },
    });
  });

  it("refuses an overlong list even when the prune would shorten it", () => {
    const shift = plan().shifts[0]!;
    const old = {
      userId: 7,
      startsAt: "2026-09-01T04:00:00.000Z",
      endsAt: "2026-09-01T12:00:00.000Z",
    };
    const values = coerceDutyPlanValues({
      name: "X",
      shifts: [old, old, ...Array(400).fill(shift)],
    });
    expect(buildDutyPlanPayload(values, null, ctx({ mode: "create" }))).toMatchObject({
      ok: false,
      fields: { shifts: "invalid" },
    });
  });

  it("reads client values defensively", () => {
    expect(
      coerceDutyPlanValues({
        name: "X",
        shiftTemplates: [{ label: "Früh", start: "06:00", end: "14:00" }, "junk"],
        shifts: [{ userId: "7", startsAt: 1, endsAt: null }],
      }),
    ).toEqual({
      name: "X",
      note: "",
      department: "",
      shiftTemplates: [{ label: "Früh", start: "06:00", end: "14:00" }],
      shifts: [{ userId: 0, startsAt: "", endsAt: "" }],
    });
  });
});
