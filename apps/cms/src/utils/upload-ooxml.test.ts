import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CT_NAMESPACE,
  MAIN_TYPES,
  buildZip,
  contentTypesXml,
  minimalDocx,
  minimalOffice,
  minimalOfficeEntries,
  minimalPptx,
  minimalXlsx,
  OOXML_FIXTURES_DIR,
  ooxmlFixture,
} from "../integration/upload.test.helper";
import { decodeAttributeValue, parseContentTypes, sniffOfficeFormat } from "./upload-ooxml";
import { ZipRefusal, readEntry, readZipLayout, type RandomAccessFile } from "./upload-zip";

/**
 * The Office Open XML rule (decision 06 §E1, owner amendment 2, amendment
 * rows A4, A6, A10; batch 16 lane 16A, spike 11) on the real producer
 * files of apps/cms/src/test/fixtures/ooxml (README there) and on built
 * cases.
 */

const fileOf = (bytes: Uint8Array): RandomAccessFile => ({
  size: bytes.length,
  read: async (position, length) => bytes.subarray(position, position + length),
});

async function verdict(bytes: Uint8Array): Promise<string> {
  try {
    return await sniffOfficeFormat(fileOf(bytes));
  } catch (error) {
    if (error instanceof ZipRefusal) return `refused: ${error.reason}`;
    throw error;
  }
}

const docxWith = (
  contentTypes: string | Uint8Array,
  extra = minimalOfficeEntries("docx").slice(1),
) => buildZip([{ name: "[Content_Types].xml", data: contentTypes }, ...extra]);

const types = (body: string, declaration = '<?xml version="1.0" encoding="UTF-8"?>') =>
  `${declaration}<Types xmlns="${CT_NAMESPACE}">${body}</Types>`;

const DEFAULTS =
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>';
const DOCX_MAIN = `<Override PartName="/word/document.xml" ContentType="${MAIN_TYPES.docx}"/>`;

describe("real producer files (spike 11)", () => {
  it.each([
    ["word-desktop.docx", "docx"],
    ["excel-desktop.xlsx", "xlsx"],
    ["powerpoint-desktop.pptx", "pptx"],
    ["python-zipfile.docx", "docx"],
    ["python-zipfile.xlsx", "xlsx"],
    ["python-zipfile.pptx", "pptx"],
    ["python-zipfile-streamed.docx", "docx"],
    ["python-zipfile-streamed.xlsx", "xlsx"],
    ["python-zipfile-streamed.pptx", "pptx"],
  ])("accepts %s as %s", async (name, format) => {
    expect(await verdict(ooxmlFixture(name))).toBe(format);
  });

  it.each([
    "word-desktop.docm",
    "word-desktop-vba.docm",
    "word-desktop.dotx",
    "word-desktop.dotm",
    "excel-desktop.xlsm",
    "excel-desktop-vba.xlsm",
    "excel-desktop-xlm.xlsm",
    "excel-desktop.xlsb",
    "excel-desktop.xltx",
    "excel-desktop.xltm",
    "excel-desktop.xlam",
    "powerpoint-desktop.pptm",
    "powerpoint-desktop-vba.pptm",
    "powerpoint-desktop.potx",
    "powerpoint-desktop.potm",
    "powerpoint-desktop.ppsx",
    "powerpoint-desktop.ppsm",
  ])("refuses %s (whatever it is named)", async (name) => {
    expect(await verdict(ooxmlFixture(name))).toMatch(/^refused/);
  });

  it("covers every fixture in the folder (a new file needs a verdict here)", () => {
    const files = readdirSync(OOXML_FIXTURES_DIR).filter((name) => name !== "README.md");
    expect(files).toHaveLength(26);
  });
});

describe("fixtures carry no personal data (L9)", () => {
  const PERSON_TAGS = /<(dc:creator|cp:lastModifiedBy)>([^<]*)<\//g;
  const COMPANY_TAGS = /<(Company|Manager)>([^<]*)<\//g;

  it.each(readdirSync(OOXML_FIXTURES_DIR).filter((name) => name !== "README.md"))(
    "%s: author empty or 'sinnlos fixture', no company",
    async (name) => {
      const bytes = ooxmlFixture(name);
      const file = fileOf(bytes);
      const layout = await readZipLayout(file);
      const props = layout.entries.filter((entry) => /^docprops\/.*\.xml$/i.test(entry.name));
      expect(props.length).toBeGreaterThan(0);
      for (const entry of props) {
        const xml = Buffer.from(
          await readEntry(file, entry, { maxCompressed: 1 << 20, maxInflated: 1 << 20 }),
        ).toString("utf8");
        for (const match of xml.matchAll(PERSON_TAGS)) {
          expect(["", "sinnlos fixture"], `${entry.name} ${match[1]}`).toContain(match[2]);
        }
        for (const match of xml.matchAll(COMPANY_TAGS)) expect(match[2], match[1]).toBe("");
        expect(xml).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
      }
    },
  );
});

describe("minimal packages and the main part (step 3)", () => {
  it("accepts the three minimal packages", async () => {
    expect(await verdict(minimalDocx())).toBe("docx");
    expect(await verdict(minimalXlsx())).toBe("xlsx");
    expect(await verdict(minimalPptx())).toBe("pptx");
  });

  it("accepts a main part with another name in its format's folder (OpenXML SDK: document2.xml)", async () => {
    expect(await verdict(minimalDocx({ mainPart: "word/document2.xml" }))).toBe("docx");
  });

  it("refuses a main part outside its format's folder, or of another format", async () => {
    expect(await verdict(minimalDocx({ mainPart: "document.xml" }))).toMatch(/outside its/);
    expect(
      await verdict(
        minimalOffice("xlsx", {
          contentTypes: contentTypesXml([
            { partName: "/xl/workbook.xml", contentType: MAIN_TYPES.docx },
          ]),
        }),
      ),
    ).toMatch(/outside its/);
  });

  it("refuses zero or two main parts, a missing one, or one on a Default", async () => {
    expect(await verdict(docxWith(types(DEFAULTS)))).toMatch(/not exactly one main/);
    expect(
      await verdict(
        docxWith(
          types(
            DEFAULTS +
              DOCX_MAIN +
              `<Override PartName="/xl/workbook.xml" ContentType="${MAIN_TYPES.xlsx}"/>`,
          ),
          [...minimalOfficeEntries("docx").slice(1), { name: "xl/workbook.xml", data: "<x/>" }],
        ),
      ),
    ).toMatch(/not exactly one main/);
    expect(
      await verdict(
        docxWith(types(DEFAULTS + DOCX_MAIN), minimalOfficeEntries("docx").slice(1, 2)),
      ),
    ).toMatch(/main part missing/);
    expect(
      await verdict(
        docxWith(
          types(
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
              `<Default Extension="xml" ContentType="${MAIN_TYPES.docx}"/>`,
          ),
        ),
      ),
    ).toMatch(/not on an Override/);
  });

  it("refuses templates and slideshows by their main content type", async () => {
    for (const [mainPart, contentType] of [
      [
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
      ],
      [
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
      ],
      [
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
      ],
    ]) {
      const bytes = minimalDocx({
        contentTypes: contentTypesXml([{ partName: `/${mainPart}`, contentType }]),
      });
      expect(await verdict(bytes), contentType).toMatch(/outside the table/);
    }
  });
});

describe("no macros (step 4)", () => {
  it.each([
    "xl/vbaProject.bin",
    "word/vbaProject.bin",
    "customXml/VBAPROJECT.BIN",
    "word/vbaProjectSignature.bin",
    "word/vbaProjectSignatureAgile.bin",
    "word/vbaProjectSignatureV3.bin",
    "word/vbaData.xml",
    "xl/macrosheets/sheet1.xml",
    "XL/MacroSheets/sheet1.xml",
  ])("refuses a clean package plus %s", async (name) => {
    const bytes = minimalDocx({ extra: [{ name, data: "x" }] });
    expect(await verdict(bytes)).toMatch(/VBA part|macro sheet/);
  });

  it.each([
    [
      "a macro-enabled main type without a VBA part",
      "application/vnd.ms-word.document.macroEnabled.main+xml",
    ],
    ["a vbaProject content type", "application/vnd.ms-office.vbaProject"],
    ["a macro sheet content type", "application/vnd.ms-excel.macrosheet+xml"],
  ])("refuses %s", async (_label, contentType) => {
    const body =
      DEFAULTS + DOCX_MAIN + `<Override PartName="/word/x.bin" ContentType="${contentType}"/>`;
    expect(await verdict(docxWith(types(body)))).toMatch(/macro content type/);
  });
});

describe("[Content_Types].xml as a bounded XML subset (step 2, amendment row A4)", () => {
  it("accepts the shapes producers write", async () => {
    expect(await verdict(docxWith(types(DEFAULTS + DOCX_MAIN)))).toBe("docx");
    expect(await verdict(docxWith(types(DEFAULTS + DOCX_MAIN, "")))).toBe("docx");
    expect(
      await verdict(
        docxWith(
          types(
            DEFAULTS + DOCX_MAIN,
            `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\r\n`,
          ),
        ),
      ),
    ).toBe("docx");
    // Whitespace between elements, single quotes, an element closed at once, a BOM.
    const spaced = types(
      `\n  ${DEFAULTS}\n  <Override PartName='/word/document.xml' ContentType='${MAIN_TYPES.docx}'></Override>\n`,
    );
    expect(await verdict(docxWith(spaced))).toBe("docx");
    expect(await verdict(docxWith("﻿" + types(DEFAULTS + DOCX_MAIN)))).toBe("docx");
  });

  it("decodes references before comparing (an encoded main type is still the main type)", async () => {
    const encoded = MAIN_TYPES.docx
      .replace("+xml", "&#43;xml")
      .replace("document", "docu&#x6D;ent");
    expect(
      await verdict(
        docxWith(
          types(DEFAULTS + `<Override PartName="/word/document.xml" ContentType="${encoded}"/>`),
        ),
      ),
    ).toBe("docx");
  });

  it.each([
    [
      "macro&#69;nabled",
      `<Override PartName="/word/a.xml" ContentType="application/vnd.ms-word.document.macro&#69;nabled.12"/>`,
      /macro content type/,
    ],
    [
      "vbaPro&#106;ect",
      `<Default Extension="bin" ContentType="application/vnd.ms-office.vbaPro&#106;ect"/>`,
      /macro content type/,
    ],
    [
      ".ma&#105;n+xml",
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.ma&#105;n+xml"/>`,
      /not exactly one main/,
    ],
  ])(
    "refuses an encoded declaration (%s) next to a clean main part",
    async (_label, element, reason) => {
      expect(await verdict(docxWith(types(DEFAULTS + DOCX_MAIN + element)))).toMatch(reason);
    },
  );

  it.each([
    ["a comment holding a content type", `<!-- ContentType="${MAIN_TYPES.docx}" -->`],
    ["a processing instruction", "<?foo bar?>"],
    ["CDATA", "<![CDATA[x]]>"],
    ["text", "hello"],
    ["another element", '<Other Extension="a" ContentType="b"/>'],
    ["a prefixed element", '<ct:Default Extension="a" ContentType="b"/>'],
    ["a foreign attribute", '<Default Extension="a" ContentType="b" x="y"/>'],
    ["a missing attribute", '<Default Extension="a"/>'],
    ["a repeated attribute", '<Default Extension="a" Extension="b" ContentType="c"/>'],
    ["attributes without whitespace", '<Default Extension="a"ContentType="b"/>'],
    ["content inside an element", '<Default Extension="a" ContentType="b"> </Default>'],
    ["an unknown entity", '<Default Extension="a" ContentType="x&nbsp;y"/>'],
    ["a malformed character reference", '<Default Extension="a" ContentType="x&#xZZ;"/>'],
    ["an unterminated reference", '<Default Extension="a" ContentType="x&amp"/>'],
    ["a decoded space", '<Default Extension="a" ContentType="x&#32;y"/>'],
    ["a decoded control character", '<Default Extension="a" ContentType="x&#x7f;y"/>'],
    ["a reference to a non-character", '<Default Extension="a" ContentType="x&#0;y"/>'],
    ["a literal tab", '<Default Extension="a" ContentType="x\ty"/>'],
    [
      "two Defaults for one extension (case-folded)",
      '<Default Extension="XML" ContentType="application/xml"/>',
    ],
    [
      "two Overrides for one part (case-folded)",
      `<Override PartName="/WORD/document.xml" ContentType="application/xml"/>`,
    ],
  ])("refuses %s", async (_label, element) => {
    expect(await verdict(docxWith(types(DEFAULTS + DOCX_MAIN + element)))).toMatch(/^refused/);
  });

  it.each([
    [
      "a DOCTYPE with an internal entity",
      `<?xml version="1.0"?><!DOCTYPE Types [<!ENTITY m "macroEnabled">]><Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    ["a foreign default namespace", `<Types xmlns="urn:other">${DEFAULTS}${DOCX_MAIN}</Types>`],
    ["a prefixed root", `<ct:Types xmlns:ct="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</ct:Types>`],
    [
      "an extra namespace declaration",
      `<Types xmlns="${CT_NAMESPACE}" xmlns:x="urn:x">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    ["another root", `<Foo xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Foo>`],
    [
      "content after the root",
      `<Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types><x/>`,
    ],
    [
      "whitespace before the declaration",
      ` <?xml version="1.0"?><Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    [
      "XML 1.1",
      `<?xml version="1.1"?><Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    [
      "another encoding",
      `<?xml version="1.0" encoding="ISO-8859-1"?><Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    [
      "a declaration out of order",
      `<?xml version="1.0" standalone="yes" encoding="UTF-8"?><Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}</Types>`,
    ],
    ["an unclosed root", `<Types xmlns="${CT_NAMESPACE}">${DEFAULTS}${DOCX_MAIN}`],
  ])("refuses %s", async (_label, xml) => {
    expect(await verdict(docxWith(xml))).toMatch(/^refused/);
  });

  it("refuses bytes that are not UTF-8", async () => {
    const latin1 = Buffer.from(
      types(DEFAULTS + DOCX_MAIN).replace("application/xml", "application/xé"),
      "latin1",
    );
    expect(await verdict(docxWith(latin1))).toBe("refused: not UTF-8");
  });

  it("bounds the entry: 64 KiB compressed, 256 KiB inflated, stored or deflate only", async () => {
    const padding = " ".repeat(300 * 1024);
    const big = types(DEFAULTS + DOCX_MAIN + padding.slice(0, 10));
    const inflatesFar = buildZip([
      { name: "[Content_Types].xml", data: big.replace("</Types>", `${padding}</Types>`) },
      ...minimalOfficeEntries("docx").slice(1),
    ]);
    expect(await verdict(inflatesFar)).toBe("refused: entry inflates too far");
    const storedLarge = buildZip([
      {
        name: "[Content_Types].xml",
        data: big.replace("</Types>", `${" ".repeat(70 * 1024)}</Types>`),
        method: 0,
      },
      ...minimalOfficeEntries("docx").slice(1),
    ]);
    expect(await verdict(storedLarge)).toBe("refused: entry too large");
  });

  it("refuses a package without [Content_Types].xml", async () => {
    expect(await verdict(buildZip(minimalOfficeEntries("docx").slice(1)))).toBe(
      "refused: no [Content_Types].xml",
    );
  });
});

describe("decodeAttributeValue", () => {
  it("decodes the five entities and character references", () => {
    expect(decodeAttributeValue("a&lt;b&gt;c&amp;d&apos;e&quot;f")).toBe("a<b>c&d'e\"f");
    expect(decodeAttributeValue("&#69;&#x45;&#x1F600;")).toBe("EE\u{1F600}");
  });

  it("refuses < and malformed references", () => {
    for (const raw of ["<", "&", "&;", "&#;", "&#x;", "&#12345678;", "&#xD800;", "&bogus;"]) {
      expect(() => decodeAttributeValue(raw), raw).toThrow(ZipRefusal);
    }
  });
});

describe("parseContentTypes", () => {
  it("returns the decoded Defaults and Overrides", () => {
    const parsed = parseContentTypes(
      Buffer.from(
        types(`${DEFAULTS}<Override PartName="/word/document.xml" ContentType="a&#47;b"/>`),
      ),
    );
    expect(parsed.defaults).toHaveLength(2);
    expect(parsed.overrides).toEqual([{ partName: "/word/document.xml", contentType: "a/b" }]);
  });
});
