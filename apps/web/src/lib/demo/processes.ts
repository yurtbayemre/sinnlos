import type { Process } from "@/lib/types";
import type { DemoClock } from "./clock";

/** A small valid BPMN 2.0 diagram: start, one task, a gateway and two ends (with its layout). */
const DEMO_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start" name="Ware trifft ein">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Check" name="Lieferschein prüfen">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:task>
    <bpmn:exclusiveGateway id="Gate" name="Vollständig?">
      <bpmn:incoming>Flow_2</bpmn:incoming>
      <bpmn:outgoing>Flow_3</bpmn:outgoing>
      <bpmn:outgoing>Flow_4</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:endEvent id="Stored" name="Einlagern">
      <bpmn:incoming>Flow_3</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:endEvent id="Returned" name="Zurücksenden">
      <bpmn:incoming>Flow_4</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start" targetRef="Check" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Check" targetRef="Gate" />
    <bpmn:sequenceFlow id="Flow_3" name="ja" sourceRef="Gate" targetRef="Stored" />
    <bpmn:sequenceFlow id="Flow_4" name="nein" sourceRef="Gate" targetRef="Returned" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_di" bpmnElement="Start"><dc:Bounds x="152" y="102" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Check_di" bpmnElement="Check"><dc:Bounds x="240" y="80" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gate_di" bpmnElement="Gate" isMarkerVisible="true"><dc:Bounds x="395" y="95" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Stored_di" bpmnElement="Stored"><dc:Bounds x="522" y="52" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Returned_di" bpmnElement="Returned"><dc:Bounds x="522" y="152" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="188" y="120" /><di:waypoint x="240" y="120" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2"><di:waypoint x="340" y="120" /><di:waypoint x="395" y="120" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_3_di" bpmnElement="Flow_3"><di:waypoint x="420" y="95" /><di:waypoint x="420" y="70" /><di:waypoint x="522" y="70" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_4_di" bpmnElement="Flow_4"><di:waypoint x="420" y="145" /><di:waypoint x="420" y="170" /><di:waypoint x="522" y="170" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;

/** Two published processes (v1.1): one with a department, one company-wide. */
export function demoProcesses(clock: DemoClock) {
  const engineering = {
    id: 1,
    documentId: "demodepartment0000000001",
    name: "Engineering",
    slug: "engineering",
  };
  const updatedAt = clock.ago(3);
  const processes: Process[] = [
    {
      id: 1,
      documentId: "demoprocess0000000000001",
      title: "Wareneingang",
      summary:
        "Die Ware kommt an der Rampe an. Jemand prüft den Lieferschein. Ist die Lieferung vollständig, wird sie eingelagert; sonst geht sie zurück.",
      diagram: DEMO_DIAGRAM,
      updatedAt,
      department: engineering,
    },
    {
      id: 2,
      documentId: "demoprocess0000000000002",
      title: "Onboarding neuer Kolleginnen und Kollegen",
      summary:
        "Eine neue Kollegin oder ein neuer Kollege startet: Zugänge, Ausstattung und der Plan der ersten Woche, in dieser Reihenfolge.",
      diagram: DEMO_DIAGRAM.replace("Ware trifft ein", "Vertrag unterschrieben"),
      updatedAt,
      department: null,
    },
  ];
  return { processes };
}
