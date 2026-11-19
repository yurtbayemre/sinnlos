import { describe, expect, it } from "vitest";
import {
  BPMN_MODEL_NAMESPACE,
  MAX_PROCESS_DIAGRAM_BYTES,
  MAX_PROCESS_DIAGRAM_CHARS,
  MAX_PROCESS_SUMMARY,
  hasUnsafePaint,
  hasXmlIllegalChar,
  processDiagramCode,
  processDiagramJsonBytes,
  processSummaryCode,
} from "./process.js";

/** A BPMN document whose comment carries `pad`. */
const bpmn = (pad = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="${BPMN_MODEL_NAMESPACE}" id="d"><!--${pad}--></bpmn:definitions>`;
/** The same, grown (with ASCII) to exactly `chars` characters. */
const bpmnOfLength = (chars: number) => bpmn("a".repeat(chars - bpmn().length));
const jsonBytes = (value: string) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("processSummaryCode", () => {
  it("accepts 1 to 2000 characters, refuses blank and longer", () => {
    expect(processSummaryCode("Order, pack, ship.")).toBeNull();
    expect(processSummaryCode("a".repeat(MAX_PROCESS_SUMMARY))).toBeNull();
    expect(processSummaryCode("a".repeat(MAX_PROCESS_SUMMARY + 1))).toBe("tooLong");
    expect(processSummaryCode("   ")).toBe("required");
    expect(processSummaryCode(null)).toBe("required");
    expect(processSummaryCode(undefined)).toBe("required");
    expect(processSummaryCode(7)).toBe("invalid");
  });
});

describe("processDiagramCode: the BPMN root", () => {
  it("accepts a prefixed root, a default-namespace root, a prolog with comments and single quotes", () => {
    expect(processDiagramCode(bpmn())).toBeNull();
    expect(
      processDiagramCode(`<definitions xmlns="${BPMN_MODEL_NAMESPACE}"><process/></definitions>`),
    ).toBeNull();
    expect(
      processDiagramCode(
        `<?xml version="1.0"?>\n<!-- made by hand -->\n<?pi x?>\n<b:definitions\n  id='d' xmlns:b='${BPMN_MODEL_NAMESPACE}' />`,
      ),
    ).toBeNull();
  });

  it("refuses everything that is not definitions in the BPMN MODEL namespace", () => {
    const refused = [
      "plain text",
      "<html><body/></html>",
      `<bpmn:process xmlns:bpmn="${BPMN_MODEL_NAMESPACE}"/>`,
      // the namespace of another prefix, a wrong namespace, none, the DI namespace
      `<bpmn:definitions xmlns:other="${BPMN_MODEL_NAMESPACE}"/>`,
      `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/DI"/>`,
      `<bpmn:definitions/>`,
      `<definitions xmlns="http://example.org/"/>`,
      // the namespace sits in a child, not on the root
      `<root><bpmn:definitions xmlns:bpmn="${BPMN_MODEL_NAMESPACE}"/></root>`,
      // a lookalike element name
      `<bpmn:definitionsX xmlns:bpmn="${BPMN_MODEL_NAMESPACE}"/>`,
      `<definitions-x xmlns="${BPMN_MODEL_NAMESPACE}"/>`,
      // an unterminated prolog or root tag
      `<?xml version="1.0"`,
      `<!-- open`,
      `<bpmn:definitions xmlns:bpmn="${BPMN_MODEL_NAMESPACE}"`,
    ];
    for (const xml of refused) expect(processDiagramCode(xml), xml).toBe("invalid");
  });

  it("refuses blank and non-string values", () => {
    expect(processDiagramCode("")).toBe("required");
    expect(processDiagramCode("  \n")).toBe("required");
    expect(processDiagramCode(null)).toBe("required");
    expect(processDiagramCode(undefined)).toBe("required");
    expect(processDiagramCode(42)).toBe("invalid");
    expect(processDiagramCode({})).toBe("invalid");
  });

  it("refuses <!DOCTYPE and <!ENTITY anywhere, whatever the case", () => {
    const refused = [
      `<!DOCTYPE definitions [<!ENTITY x "y">]>${bpmn()}`,
      `<?xml version="1.0"?><!DOCTYPE definitions>${bpmn()}`,
      bpmn("<!ENTITY lol 'lol'>"),
      bpmn("<!doctype x>"),
      `<!-- <!DOCTYPE inside a comment is refused too -->${bpmn()}`,
    ];
    for (const xml of refused) expect(processDiagramCode(xml), xml).toBe("invalid");
  });

  it("does not choke on a hostile start tag (bounded scan)", () => {
    const started = Date.now();
    const attributes = ` a="${"x".repeat(30)}"`.repeat(5000);
    processDiagramCode(`<bpmn:definitions${attributes}`);
    processDiagramCode(`<bpmn:definitions${" ".repeat(100_000)}x`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("processDiagramCode: size (rev3, exact boundaries)", () => {
  it("accepts 300 000 characters and refuses 300 001", () => {
    expect(bpmnOfLength(MAX_PROCESS_DIAGRAM_CHARS).length).toBe(300_000);
    expect(processDiagramCode(bpmnOfLength(MAX_PROCESS_DIAGRAM_CHARS))).toBeNull();
    expect(processDiagramCode(bpmnOfLength(MAX_PROCESS_DIAGRAM_CHARS + 1))).toBe("tooLong");
  });

  it("accepts JSON.stringify(diagram) of exactly 700 KiB and refuses one byte more", () => {
    // Three-byte characters get the field to the byte limit well below 300 000 characters.
    const base = jsonBytes(bpmn());
    const room = MAX_PROCESS_DIAGRAM_BYTES - base;
    const exact = bpmn("€".repeat(Math.floor(room / 3)) + "a".repeat(room % 3));
    expect(jsonBytes(exact)).toBe(MAX_PROCESS_DIAGRAM_BYTES);
    expect(processDiagramJsonBytes(exact)).toBe(MAX_PROCESS_DIAGRAM_BYTES);
    expect(exact.length).toBeLessThan(MAX_PROCESS_DIAGRAM_CHARS);
    expect(processDiagramCode(exact)).toBeNull();
    const over = bpmn("€".repeat(Math.floor(room / 3)) + "a".repeat((room % 3) + 1));
    expect(jsonBytes(over)).toBe(MAX_PROCESS_DIAGRAM_BYTES + 1);
    expect(processDiagramCode(over)).toBe("tooLong");
  });

  it("counts the JSON escapes: quotes, backslashes and newlines cost two bytes", () => {
    const text = bpmn('"\\\n');
    expect(processDiagramJsonBytes(text)).toBe(jsonBytes(text));
    expect(processDiagramJsonBytes(text)).toBeGreaterThan(text.length + 2);
    // 4-byte characters (emoji, two UTF-16 units) count as 4 bytes.
    const emoji = bpmn("\u{1f642}".repeat(10));
    expect(processDiagramJsonBytes(emoji)).toBe(jsonBytes(emoji));
  });
});

describe("processDiagramCode: XML-illegal characters", () => {
  it("refuses C0 controls but TAB, LF and CR, lone surrogates, U+FFFE and U+FFFF", () => {
    for (const bad of [
      "\u0000",
      "\u0001",
      "\u0008",
      "\u000b",
      "\u000c",
      "\u001f",
      "\ud800",
      "\udc00",
      "￾",
      "￿",
    ]) {
      expect(processDiagramCode(bpmn(`x${bad}y`)), JSON.stringify(bad)).toBe("invalid");
    }
    // a high surrogate at the end, a low one without its high one
    expect(processDiagramCode(bpmn("x\ud83d"))).toBe("invalid");
    expect(processDiagramCode(bpmn("\ude42x"))).toBe("invalid");
  });

  it("accepts TAB, LF, CR, umlauts and emoji pairs", () => {
    expect(processDiagramCode(bpmn("a\tb\nc\rd äöüß \u{1f642}"))).toBeNull();
    expect(hasXmlIllegalChar("\t\n\r \u007f\u0085🙂")).toBe(false);
  });

  it("refuses 180 000 x U+0001 by the character rule, not by size", () => {
    const text = bpmn("\u0001".repeat(180_000));
    expect(text.length).toBeLessThan(MAX_PROCESS_DIAGRAM_CHARS);
    expect(processDiagramCode(text)).toBe("invalid");
  });
});

/** A diagram whose shape carries `attributes` on its DI element. */
const withShape = (attributes: string) =>
  `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="${BPMN_MODEL_NAMESPACE}" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0" xmlns:zz="http://bpmn.io/schema/bpmn/biocolor/1.0">
  <bpmn:process id="p"><bpmn:startEvent id="s"/></bpmn:process>
  <bpmndi:BPMNDiagram id="di"><bpmndi:BPMNPlane id="pl" bpmnElement="p">
    <bpmndi:BPMNShape id="sh" bpmnElement="s" ${attributes}/>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

describe("processDiagramCode: labels and handlers are text to bpmn-js, paint is not", () => {
  // Fixtures of the plan (rev2/rev3): checked against bpmn-js 18.33.0 in Chromium (e2e/processes.spec.ts
  // and the probe of the build): labels, documentation and unknown attributes (onclick) end up as
  // text or are dropped, no script and no handler reaches the SVG. A url() in a color is requested.
  it("accepts labels and documentation with markup, handlers and plain colors", () => {
    const hostile = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="${BPMN_MODEL_NAMESPACE}" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0">
  <bpmn:process id="p" name="&lt;img src=x onerror=alert(1)&gt;">
    <bpmn:documentation>&lt;script&gt;alert(1)&lt;/script&gt;</bpmn:documentation>
    <bpmn:startEvent id="s" name="&lt;script&gt;alert(2)&lt;/script&gt;" onclick="alert(3)"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="di"><bpmndi:BPMNPlane id="pl" bpmnElement="p">
    <bpmndi:BPMNShape id="sh" bpmnElement="s" bioc:stroke="#1a2b3c" bioc:fill="red"/>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
    expect(processDiagramCode(hostile)).toBeNull();
  });

  it("accepts plain colors: hex, names, rgb() and hsl(), empty, in any DI attribute and quote", () => {
    for (const color of [
      "#fff",
      "#FFAA00",
      "#1a2b3c4d",
      "red",
      "darkBlue",
      "transparent",
      "rgb(1, 2, 3)",
      "rgba(0,0,0,0.5)",
      "hsl(120, 50%, 40%)",
      "",
    ]) {
      expect(processDiagramCode(withShape(`bioc:stroke="${color}"`)), color).toBeNull();
    }
    expect(
      processDiagramCode(
        withShape(
          `bioc:fill='#fff' color:background-color="#eee" color:border-color="#111" color:color="#222"`,
        ),
      ),
    ).toBeNull();
  });

  it("refuses a color that would make the browser request an address, in every attribute bpmn-js reads", () => {
    const url = "url(https://evil.example/x.svg#a)";
    for (const attribute of [
      "bioc:stroke",
      "bioc:fill",
      "color:background-color",
      "color:border-color",
      "color:color",
    ]) {
      expect(processDiagramCode(withShape(`${attribute}="${url}"`)), attribute).toBe("invalid");
      expect(processDiagramCode(withShape(`${attribute}='${url}'`)), attribute).toBe("invalid");
    }
  });

  it("refuses the same under another namespace prefix, and the disguises of url()", () => {
    const refused = [
      `zz:stroke="url(http://evil.example/p.svg#a)"`,
      `zz:fill = "url( http://evil.example/p.svg#a )"`,
      `bioc:stroke="URL(http://evil.example/x)"`,
      // an XML character reference decodes to the letter u: the raw value is no plain color
      `bioc:stroke="&#117;rl(http://evil.example/x)"`,
      `bioc:stroke="&#x75;rl(http://evil.example/x)"`,
      // a CSS escape
      `bioc:stroke="u\\72l(http://evil.example/x)"`,
      // more than a color
      `bioc:stroke="red;background:url(http://evil.example/x)"`,
      `bioc:fill="expression(alert(1))"`,
      `bioc:fill="red url(#x)"`,
      `bioc:fill="var(--x)"`,
      `bioc:stroke="#12"`,
      `bioc:stroke="rgb(1,2,3)url(x)"`,
    ];
    for (const attributes of refused) {
      expect(processDiagramCode(withShape(attributes)), attributes).toBe("invalid");
    }
  });

  it("does not refuse a label or text that merely mentions url(): only paint attributes count", () => {
    const text = withShape(`bioc:stroke="red"`).replace(
      '<bpmn:startEvent id="s"/>',
      '<bpmn:startEvent id="s" name="open url(https://x) or fill: red"><bpmn:documentation>url(a) stroke</bpmn:documentation></bpmn:startEvent>',
    );
    expect(processDiagramCode(text)).toBeNull();
  });
});

describe("hasUnsafePaint", () => {
  it("is false without paint attributes and true for anything but a plain color", () => {
    expect(hasUnsafePaint("<a/>")).toBe(false);
    expect(hasUnsafePaint('<a bioc:fill="#fff"/>')).toBe(false);
    expect(hasUnsafePaint('<a bioc:fill="url(#x)"/>')).toBe(true);
    expect(hasUnsafePaint("<a stroke='url(#x)'/>")).toBe(true);
  });

  it("stays linear on a hostile document", () => {
    const started = Date.now();
    hasUnsafePaint(`<a ${"fill ".repeat(60_000)}/>`);
    hasUnsafePaint(`<a fill=${" ".repeat(200_000)}"x"/>`);
    hasUnsafePaint(`<a ${'fill="red" '.repeat(20_000)}/>`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
