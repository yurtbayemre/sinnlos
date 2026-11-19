import { describe, expect, it } from "vitest";
import { MAX_PROCESS_DIAGRAM_BYTES, processDiagramCode } from "@sinnlos/domain";
import { NEW_PROCESS_DIAGRAM, diagramFileName, importFileTooLarge } from "./process-diagram";

/** The browser side of a process diagram: the empty diagram, the import checks, the file names. */
describe("NEW_PROCESS_DIAGRAM", () => {
  it("is a storable BPMN diagram with exactly one start event and its layout", () => {
    expect(processDiagramCode(NEW_PROCESS_DIAGRAM)).toBeNull();
    expect(NEW_PROCESS_DIAGRAM.match(/<bpmn:startEvent /g)).toHaveLength(1);
    expect(NEW_PROCESS_DIAGRAM.match(/<bpmndi:BPMNShape /g)).toHaveLength(1);
    expect(NEW_PROCESS_DIAGRAM).not.toMatch(/<bpmn:(task|endEvent|sequenceFlow)/);
  });
});

describe("importFileTooLarge: the size is checked before the file is read", () => {
  it("accepts a file of exactly 700 KiB and refuses one byte more", () => {
    expect(MAX_PROCESS_DIAGRAM_BYTES).toBe(700 * 1024);
    expect(importFileTooLarge({ size: MAX_PROCESS_DIAGRAM_BYTES })).toBe(false);
    expect(importFileTooLarge({ size: MAX_PROCESS_DIAGRAM_BYTES + 1 })).toBe(true);
    expect(importFileTooLarge({ size: 0 })).toBe(false);
    expect(importFileTooLarge({ size: 50 * 1024 * 1024 })).toBe(true);
  });
});

describe("diagramFileName", () => {
  it("makes a plain file name of the title, keeping letters and digits of any script", () => {
    expect(diagramFileName("Wareneingang", "bpmn")).toBe("wareneingang.bpmn");
    expect(diagramFileName("Prüfung / Freigabe: Q3 2026!", "svg")).toBe(
      "prüfung-freigabe-q3-2026.svg",
    );
    expect(diagramFileName("../../etc/passwd", "bpmn")).toBe("etc-passwd.bpmn");
    expect(diagramFileName('"><script>x</script>', "svg")).toBe("script-x-script.svg");
  });

  it("falls back to 'process' for a title without letters and bounds the length", () => {
    expect(diagramFileName("***", "bpmn")).toBe("process.bpmn");
    expect(diagramFileName("", "svg")).toBe("process.svg");
    expect(diagramFileName("a".repeat(500), "bpmn")).toBe(`${"a".repeat(80)}.bpmn`);
  });
});
