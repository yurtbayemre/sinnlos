import { describe, expect, it } from "vitest";
import {
  MAX_PROCESS_DIAGRAM_BYTES,
  MAX_PROCESS_REQUEST_BYTES,
  MAX_PROCESS_SUMMARY,
  processDiagramJsonBytes,
} from "@sinnlos/domain";
import { NEW_PROCESS_DIAGRAM } from "@/lib/process-diagram";
import { buildProcessPayload, type PayloadContext } from "./payload";
import { coerceProcessValues, emptyProcessValues, type ProcessValues } from "./values";

/**
 * The process payload (v1.1 "Tools"): the shared rules' codes on their fields, the
 * department pinned for a department author, only changed fields on an update, a
 * diagram that is never cut, and a whole request that must fit under 1 000 000 bytes.
 */
const ENG = "deptengineering000000000";
const ctx = (overrides: Partial<PayloadContext> = {}): PayloadContext => ({
  mode: "create",
  roleClass: "departmentAuthor",
  timeZone: "Europe/Berlin",
  now: Date.parse("2026-11-19T10:00:00.000Z"),
  ownDepartment: ENG,
  ...overrides,
});
const process = (patch: Partial<ProcessValues> = {}): ProcessValues => ({
  ...emptyProcessValues(ENG, NEW_PROCESS_DIAGRAM),
  title: "Wareneingang",
  summary: "Ware annehmen, prüfen, einlagern.",
  ...patch,
});
/** A valid diagram whose JSON-serialised size is `bytes`, grown with three-byte characters. */
const diagramOfBytes = (bytes: number) => {
  const wrap = (pad: string) =>
    NEW_PROCESS_DIAGRAM.replace("</bpmn:definitions>", `<!--${pad}--></bpmn:definitions>`);
  const room = bytes - processDiagramJsonBytes(wrap(""));
  return wrap("€".repeat(Math.floor(room / 3)) + "a".repeat(room % 3));
};

describe("buildProcessPayload", () => {
  it("sends every field on create, the department pinned to the author's", () => {
    expect(buildProcessPayload(process(), null, ctx())).toEqual({
      ok: true,
      data: {
        title: "Wareneingang",
        summary: "Ware annehmen, prüfen, einlagern.",
        department: ENG,
        diagram: NEW_PROCESS_DIAGRAM,
      },
    });
  });

  it("sends the company-wide department as null", () => {
    const built = buildProcessPayload(
      process({ department: "" }),
      null,
      ctx({ roleClass: "moderator" }),
    );
    expect(built).toMatchObject({ ok: true, data: { department: null } });
  });

  it("sends only the changed fields on update, and nothing for an untouched process", () => {
    const initial = process();
    expect(buildProcessPayload(process(), initial, ctx({ mode: "update" }))).toEqual({
      ok: true,
      data: {},
    });
    expect(
      buildProcessPayload(
        process({ summary: "Neu beschrieben." }),
        initial,
        ctx({ mode: "update" }),
      ),
    ).toEqual({ ok: true, data: { summary: "Neu beschrieben." } });
    const edited = NEW_PROCESS_DIAGRAM.replace("StartEvent_1", "Start_2");
    expect(
      buildProcessPayload(process({ diagram: edited }), initial, ctx({ mode: "update" })),
    ).toEqual({ ok: true, data: { diagram: edited } });
  });

  it("refuses with the shared codes on the field, before any request", () => {
    const refusal = (patch: Partial<ProcessValues>) => {
      const built = buildProcessPayload(process(patch), null, ctx());
      return built.ok ? null : built.fields;
    };
    expect(refusal({ title: "  " })).toEqual({ title: "required" });
    expect(refusal({ summary: "  " })).toEqual({ summary: "required" });
    expect(refusal({ summary: "s".repeat(MAX_PROCESS_SUMMARY + 1) })).toEqual({
      summary: "tooLong",
    });
    expect(refusal({ diagram: "<html/>" })).toEqual({ diagram: "invalid" });
    expect(refusal({ diagram: "" })).toEqual({ diagram: "required" });
    expect(
      refusal({ diagram: NEW_PROCESS_DIAGRAM.replace("<bpmn:process", "\u0001<bpmn:process") }),
    ).toEqual({
      diagram: "invalid",
    });
  });

  it("accepts a diagram of exactly 700 KiB serialised and refuses one byte more (never cut)", () => {
    const exact = diagramOfBytes(MAX_PROCESS_DIAGRAM_BYTES);
    expect(processDiagramJsonBytes(exact)).toBe(MAX_PROCESS_DIAGRAM_BYTES);
    expect(buildProcessPayload(process({ diagram: exact }), null, ctx()).ok).toBe(true);
    const over = diagramOfBytes(MAX_PROCESS_DIAGRAM_BYTES + 1);
    expect(buildProcessPayload(process({ diagram: over }), null, ctx())).toEqual({
      ok: false,
      fields: { diagram: "tooLong" },
    });
  });

  it("sends the largest allowed request (all three fields at their limits) under the request budget", () => {
    const built = buildProcessPayload(
      process({
        title: "t".repeat(255),
        summary: "s".repeat(MAX_PROCESS_SUMMARY),
        diagram: diagramOfBytes(MAX_PROCESS_DIAGRAM_BYTES),
      }),
      null,
      ctx(),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      const bytes = new TextEncoder().encode(JSON.stringify({ data: built.data })).length;
      // 730 415 bytes at most (plan rev3): under the 1 000 000 guard and koa-body's 1 MiB.
      expect(bytes).toBeLessThan(740_000);
      expect(bytes).toBeLessThan(MAX_PROCESS_REQUEST_BYTES);
    }
  });

  it("refuses a request above 1 000 000 bytes before it is sent, whatever fills it", () => {
    // The department is no checked field: only the whole-request guard stops this one.
    const big = process({
      department: "d".repeat(400_000),
      diagram: diagramOfBytes(MAX_PROCESS_DIAGRAM_BYTES),
    });
    expect(buildProcessPayload(big, null, ctx({ roleClass: "moderator" }))).toEqual({
      ok: false,
      fields: { diagram: "tooLong" },
    });
  });
});

describe("coerceProcessValues keeps the diagram whole", () => {
  it("does not slice a long diagram (the shared text coercion cuts at 210 000)", () => {
    const long = `${NEW_PROCESS_DIAGRAM}${"x".repeat(250_000)}`;
    const values = coerceProcessValues({
      title: "T",
      summary: "S",
      department: " d ",
      diagram: long,
    });
    expect(values.diagram).toBe(long);
    expect(values.department).toBe("d");
    // Above 210 000 characters and under the limit: sent whole, byte for byte.
    expect(buildProcessPayload(values, null, ctx())).toMatchObject({
      ok: true,
      data: { diagram: long },
    });
    // An excess reaches the payload rules, which refuse it instead of storing a cut XML.
    const tooLong = NEW_PROCESS_DIAGRAM.replace(
      "</bpmn:definitions>",
      `<!--${"a".repeat(300_001)}--></bpmn:definitions>`,
    );
    expect(
      buildProcessPayload(
        coerceProcessValues({ title: "T", summary: "S", diagram: tooLong }),
        null,
        ctx(),
      ),
    ).toEqual({
      ok: false,
      fields: { diagram: "tooLong" },
    });
  });

  it("reads anything that is no object, or a field of the wrong type, as empty", () => {
    expect(coerceProcessValues(null)).toEqual({
      title: "",
      summary: "",
      department: "",
      diagram: "",
    });
    expect(coerceProcessValues({ title: 7, summary: [], diagram: {} })).toEqual({
      title: "",
      summary: "",
      department: "",
      diagram: "",
    });
  });
});
