import { MAX_PROCESS_DIAGRAM_BYTES } from "@sinnlos/domain";

/**
 * The browser side of a process diagram (v1.1 "Tools"): the empty diagram of
 * a new process, the checks of an imported file and the names of the
 * downloads. Pure and free of bpmn-js, so the lazy chunks stay the only
 * place the library is loaded and the checks run in unit tests.
 */

/** A new process: one start event, with its layout (the bpmn.io empty diagram). */
export const NEW_PROCESS_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="179" y="99" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

/**
 * The size check of an imported file, BEFORE it is read: the JSON-serialised
 * diagram may not exceed MAX_PROCESS_DIAGRAM_BYTES, and the serialised form
 * is never shorter than the file, so a larger file is refused unread.
 */
export function importFileTooLarge(file: { size: number }): boolean {
  return file.size > MAX_PROCESS_DIAGRAM_BYTES;
}

/** `name.bpmn` or `name.svg` for the download: the title as a plain file name. */
export function diagramFileName(title: string, extension: "bpmn" | "svg"): string {
  const base = title
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase();
  return `${base || "process"}.${extension}`;
}
