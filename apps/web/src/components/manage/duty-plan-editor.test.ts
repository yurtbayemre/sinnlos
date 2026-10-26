import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DutyShift, DutyShiftTemplate } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import type { DutyPlanValues } from "@/lib/manage/values";

/**
 * The duty editor's time math, driven through its own handlers (audit #174):
 * the component is called as a function under a shallow hook shim, a field's
 * render callback is called for its input, and the shifts the handler writes
 * are read from setValue. Europe/Berlin, with both 2026 clock changes
 * (29 March: 02:00 → 03:00; 25 October: 03:00 → 02:00). Since v0.32 (#183)
 * a wall time a clock change skips or repeats is refused, not guessed: it
 * stays as typed, and the save names it (duty-plan-payload.test.ts).
 */
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useMemo: (make: () => unknown) => make(),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/manage/duty-plan-actions", () => ({
  saveDutyPlan: vi.fn(),
  publishDutyPlan: vi.fn(),
  unpublishDutyPlan: vi.fn(),
  discardDutyPlan: vi.fn(),
  deleteDutyPlan: vi.fn(),
}));
vi.mock("./editor-chrome", () => ({
  ConflictDialog: () => null,
  EditorStatus: () => null,
  FormAlert: () => null,
  useFieldError: () => () => undefined,
}));
vi.mock("./publish-bar", () => ({ draftSubmit: () => () => {}, PublishBar: () => null }));
const item = vi.hoisted(() => ({ values: null as unknown, setValue: vi.fn() }));
vi.mock("./use-item-editor", () => ({
  useItemEditor: () => ({
    values: item.values,
    setValue: item.setValue,
    dirty: false,
    handlers: { saveDraft: () => {} },
    reload: () => {},
    editor: { fieldErrors: {}, pending: false, meta: null, failure: null },
  }),
}));

const { DutyPlanEditor } = await import("./duty-plan-editor");

type Props = Record<string, unknown> & { children?: ReactNode };

/** The first element in `node` (props.children, depth first) that `match` accepts. */
function find(node: ReactNode, match: (props: Props) => boolean): Props {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) queue.unshift(...next);
    else if (isValidElement(next)) {
      const props = (next as ReactElement<Props>).props;
      if (match(props)) return props;
      queue.unshift(props.children);
    }
  }
  throw new Error("no such element");
}

const TZ = "Europe/Berlin";
const NIGHT: DutyShiftTemplate = { label: "Nacht", start: "22:00", end: "06:00" };
const EARLY: DutyShiftTemplate = { label: "Früh", start: "06:00", end: "14:00" };

function render(shifts: DutyShift[], shiftTemplates: DutyShiftTemplate[] = [NIGHT, EARLY]) {
  item.values = {
    name: "Bereitschaft",
    note: "",
    department: "",
    shiftTemplates,
    shifts,
  } satisfies DutyPlanValues;
  return DutyPlanEditor({
    editable: null,
    access: { roleClass: "moderator", verbs: ["create"] } as unknown as AreaAccess,
    timeZone: TZ,
    departments: [],
    optionsFailed: false,
    optionsTruncated: false,
    ownDepartment: null,
    people: [],
    peopleFailed: false,
  });
}

type Control = { value: string; onChange: (event: { target: { value: string } }) => void };

/** The input of the field `part` of shift row `row`, through the field's render callback. */
function control(tree: ReactNode, row: number, part: string): Control {
  const id = `duty-plan-shifts-${row}-${part}`;
  const field = find(tree, (props) => props.id === id && typeof props.children === "function");
  return (field.children as unknown as (a11y: { id: string }) => ReactElement<Control>)({ id })
    .props;
}

/** The shifts the last handler wrote. */
function written(): DutyShift[] {
  const call = item.setValue.mock.calls.filter(([key]) => key === "shifts").at(-1);
  if (!call) throw new Error("no shifts written");
  return call[1] as DutyShift[];
}

/** Types `value` into field `part` of row 0 and returns row 0 as written. */
function type(shift: DutyShift, part: string, value: string): DutyShift {
  control(render([shift]), 0, part).onChange({ target: { value } });
  return written()[0]!;
}

/** Picks template `label` for row 0 and returns row 0 as written. */
function pick(shift: DutyShift, label: string, templates?: DutyShiftTemplate[]): DutyShift {
  const picker = find(
    render([shift], templates),
    (props) => props.id === "duty-plan-shifts-0-template",
  );
  (picker.onChange as (label: string) => void)(label);
  return written()[0]!;
}

const shift = (startsAt: string, endsAt: string): DutyShift => ({ userId: 7, startsAt, endsAt });

beforeEach(() => item.setValue.mockClear());

describe("the duty editor's time math (Europe/Berlin)", () => {
  it("builds a day shift and a night shift from their templates", () => {
    const summer = shift("2026-06-15T04:00:00.000Z", "2026-06-15T05:00:00.000Z");
    expect(pick(summer, "Früh")).toEqual(
      shift("2026-06-15T04:00:00.000Z", "2026-06-15T12:00:00.000Z"),
    );
    const winter = shift("2026-01-10T05:00:00.000Z", "2026-01-10T13:00:00.000Z");
    // The end at or before the start is the next day.
    expect(pick(winter, "Nacht")).toEqual(
      shift("2026-01-10T21:00:00.000Z", "2026-01-11T05:00:00.000Z"),
    );
  });

  it("builds night shifts across both clock changes at their wall times", () => {
    // 22:00 CET → 06:00 CEST: seven hours.
    expect(pick(shift("2026-03-28T05:00:00.000Z", "2026-03-28T13:00:00.000Z"), "Nacht")).toEqual(
      shift("2026-03-28T21:00:00.000Z", "2026-03-29T04:00:00.000Z"),
    );
    // 22:00 CEST → 06:00 CET: nine hours.
    expect(pick(shift("2026-10-24T04:00:00.000Z", "2026-10-24T12:00:00.000Z"), "Nacht")).toEqual(
      shift("2026-10-24T20:00:00.000Z", "2026-10-25T05:00:00.000Z"),
    );
  });

  it("recognises a shift that matches a template, the next-day end included", () => {
    const night = shift("2026-10-24T20:00:00.000Z", "2026-10-25T05:00:00.000Z");
    const picker = find(render([night]), (props) => props.id === "duty-plan-shifts-0-template");
    expect(picker.value).toBe("Nacht");
  });

  it("adds a shift from the first template on the last shift's day", () => {
    const tree = render([shift("2026-03-28T21:00:00.000Z", "2026-03-29T04:00:00.000Z")]);
    const add = find(
      tree,
      (props) =>
        Array.isArray(props.children) &&
        props.children.includes("fields.shifts.add") &&
        typeof props.onClick === "function",
    );
    (add.onClick as () => void)();
    expect(written()[1]).toEqual({
      userId: 0,
      startsAt: "2026-03-28T21:00:00.000Z",
      endsAt: "2026-03-29T04:00:00.000Z",
    });
  });

  // Ends at the second 02:30 of 25 October (CET), which instantOf would never
  // pick: rebuilding the end from its wall time would move it back an hour.
  const late = shift("2026-10-24T20:00:00.000Z", "2026-10-25T01:30:00.000Z");

  describe("moving the start day moves the end with it", () => {
    const day = shift("2026-06-15T04:00:00.000Z", "2026-06-15T12:00:00.000Z");
    const night = shift("2026-06-30T20:00:00.000Z", "2026-07-01T04:00:00.000Z");

    it("by one day, and back by two", () => {
      expect(type(day, "startDay", "2026-06-16")).toEqual(
        shift("2026-06-16T04:00:00.000Z", "2026-06-16T12:00:00.000Z"),
      );
      expect(type(day, "startDay", "2026-06-13")).toEqual(
        shift("2026-06-13T04:00:00.000Z", "2026-06-13T12:00:00.000Z"),
      );
    });

    it("across a month end, a night shift keeping its next-day end", () => {
      expect(type(night, "startDay", "2026-07-01")).toEqual(
        shift("2026-07-01T20:00:00.000Z", "2026-07-02T04:00:00.000Z"),
      );
    });

    it("into the spring clock change at the same wall times", () => {
      // Sat 28 → Sun 29 March: 22:00 CET → 06:00 CEST.
      const before = shift("2026-03-27T21:00:00.000Z", "2026-03-28T05:00:00.000Z");
      expect(type(before, "startDay", "2026-03-28")).toEqual(
        shift("2026-03-28T21:00:00.000Z", "2026-03-29T04:00:00.000Z"),
      );
    });

    it("not at all to the same day: the end keeps its instant", () => {
      expect(type(late, "startDay", "2026-10-24")).toEqual(late);
    });

    it("not at all to an emptied day: the start stays as typed, the end keeps its instant", () => {
      expect(type(late, "startDay", "")).toEqual({ ...late, startsAt: "T22:00" });
    });
  });

  describe("a wall time in a clock change is refused and kept as typed (#183)", () => {
    it("March's missing 02:30, shown again as typed; the end keeps its instant", () => {
      const sunday = shift("2026-03-29T04:00:00.000Z", "2026-03-29T12:00:00.000Z");
      const typed = type(sunday, "start", "02:30");
      expect(typed).toEqual({ ...sunday, startsAt: "2026-03-29T02:30" });
      const tree = render([typed]);
      expect(control(tree, 0, "startDay").value).toBe("2026-03-29");
      expect(control(tree, 0, "start").value).toBe("02:30");
    });

    it("October's twice-occurring 02:30", () => {
      const sunday = shift("2026-10-25T05:00:00.000Z", "2026-10-25T13:00:00.000Z");
      expect(type(sunday, "start", "02:30").startsAt).toBe("2026-10-25T02:30");
    });

    it("a template whose start the day skips", () => {
      const sunday = shift("2026-03-29T04:00:00.000Z", "2026-03-29T12:00:00.000Z");
      expect(pick(sunday, "Lücke", [{ label: "Lücke", start: "02:30", end: "10:00" }])).toEqual(
        shift("2026-03-29T02:30", "2026-03-29T08:00:00.000Z"),
      );
    });

    it("copy week into the spring change keeps that start as typed", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T10:00:00Z")); // the week from Monday 16 March
      try {
        // Sunday 22 March, 02:30–10:30 CET.
        const sunday = shift("2026-03-22T01:30:00.000Z", "2026-03-22T09:30:00.000Z");
        const copy = find(
          render([sunday]),
          (props) =>
            Array.isArray(props.children) &&
            props.children.includes("fields.shifts.copyWeek") &&
            typeof props.onClick === "function",
        );
        (copy.onClick as () => void)();
        expect(written()).toEqual([sunday, shift("2026-03-29T02:30", "2026-03-29T08:30:00.000Z")]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("editing one endpoint keeps the other's instant", () => {
    it("a new start time", () => {
      expect(type(late, "start", "23:00")).toEqual(
        shift("2026-10-24T21:00:00.000Z", "2026-10-25T01:30:00.000Z"),
      );
    });

    it("a new end time, with the start at the second 02:30", () => {
      const early = shift("2026-10-25T01:30:00.000Z", "2026-10-25T05:00:00.000Z");
      expect(type(early, "end", "07:00")).toEqual(
        shift("2026-10-25T01:30:00.000Z", "2026-10-25T06:00:00.000Z"),
      );
    });
  });

  it("keeps an incomplete input as typed and shows it again", () => {
    const day = shift("2026-06-15T04:00:00.000Z", "2026-06-15T12:00:00.000Z");
    const typed = type(day, "end", "");
    expect(typed).toEqual({ ...day, endsAt: "2026-06-15T" });
    const tree = render([typed]);
    expect(control(tree, 0, "endDay").value).toBe("2026-06-15");
    expect(control(tree, 0, "end").value).toBe("");
    expect(control(tree, 0, "start").value).toBe("06:00");
  });
});
