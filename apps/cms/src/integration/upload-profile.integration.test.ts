import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_MAX_BYTES, UPLOAD_FORMAT_SPECS } from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";
import { testSchema } from "./pg-lock.test.helper";
import {
  buildZip,
  buildZipWithOffsets,
  contentTypesXml,
  minimalDocx,
  minimalOfficeEntries,
  minimalPdf,
  ooxmlFixture,
  pngOfSize,
  PNG_1PX,
  uploadFiles,
  type UploadResponse,
} from "./upload.test.helper";

/**
 * The upload profile through the real POST /api/upload (deep-dive decision
 * 06 §E1, owner amendments 1 and 2; batch 16 lane 16A, spike 11 matrix,
 * S3.1-S3.3, contract K14) on SQLite and Postgres 16: what is stored (the
 * row's name, ext and mime together) and what is refused with which code.
 */

const FILE = "plugin::upload.file";
const spec = UPLOAD_FORMAT_SPECS;

describe.each(testEngines())("the upload profile on %s", (engine) => {
  let t: TestStrapi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });
  afterAll(async () => {
    await t?.stop();
  });

  const upload = async (
    role: Parameters<TestStrapi["loginAs"]>[0],
    files: Array<{ name: string; bytes: Uint8Array; type?: string }>,
    fields: Record<string, string> = {},
    query = "",
  ): Promise<UploadResponse> => uploadFiles(t, await t.loginAs(role), files, fields, query);

  const storedRow = async (res: UploadResponse) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Array.isArray(res.body) && res.body.length).toBe(1);
    return t.strapi.db.query(FILE).findOne({ where: { id: res.body[0].id } });
  };

  const refusedWith = (res: UploadResponse, code: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatchObject({
      name: "ValidationError",
      details: { keys: ["file"], codes: { file: code } },
    });
  };

  it.each([
    ["word-desktop.docx", "docx"],
    ["excel-desktop.xlsx", "xlsx"],
    ["powerpoint-desktop.pptx", "pptx"],
    ["python-zipfile-streamed.xlsx", "xlsx"],
    ["python-zipfile.pptx", "pptx"],
  ] as const)("an editor's %s is stored as %s, by content", async (fixture, format) => {
    const res = await upload(
      "editor",
      [{ name: "Quarterly plan.bin", type: "text/html", bytes: ooxmlFixture(fixture) }],
      { fileInfo: JSON.stringify({ name: "evil.html", alternativeText: "plan" }) },
    );
    const row = await storedRow(res);
    expect([row?.name, row?.ext, row?.mime]).toEqual([
      `Quarterly plan${spec[format].extension}`,
      spec[format].extension,
      spec[format].mime,
    ]);
    expect(row?.alternativeText).toBe("plan");
    expect((row?.provider_metadata as { uploadedBy?: number }).uploadedBy).toBe(
      t.fixtures.users.editor.id,
    );
  });

  it("an editor's PDF and DOCX (S3.1), a PDF declared as PNG stored as PDF (S3.2)", async () => {
    const pdf = await storedRow(
      await upload("editor", [{ name: "looks.png", type: "image/png", bytes: minimalPdf() }]),
    );
    expect([pdf?.name, pdf?.ext, pdf?.mime]).toEqual(["looks.pdf", ".pdf", "application/pdf"]);
    const docx = await storedRow(
      await upload("editor", [{ name: "memo.docx", bytes: minimalDocx() }]),
    );
    expect(docx?.mime).toBe(spec.docx.mime);
  });

  it("a department head's XLSX is accepted; a member's is refused, a member's PNG accepted", async () => {
    const xlsx = ooxmlFixture("excel-desktop.xlsx");
    const head = await storedRow(
      await upload("department_head", [{ name: "budget.xlsx", bytes: xlsx }]),
    );
    expect(head?.ext).toBe(".xlsx");
    refusedWith(await upload("member", [{ name: "budget.xlsx", bytes: xlsx }]), "fileType");
    refusedWith(await upload("team_lead", [{ name: "x.pdf", bytes: minimalPdf() }]), "fileType");
    const png = await storedRow(await upload("member", [{ name: "bike.png", bytes: PNG_1PX }]));
    expect([png?.ext, png?.mime]).toEqual([".png", "image/png"]);
  });

  it.each([
    "word-desktop.docm",
    "word-desktop-vba.docm",
    "word-desktop.dotx",
    "excel-desktop.xlsm",
    "excel-desktop-vba.xlsm",
    "excel-desktop-xlm.xlsm",
    "excel-desktop.xlsb",
    "excel-desktop.xltx",
    "excel-desktop.xlam",
    "powerpoint-desktop.pptm",
    "powerpoint-desktop-vba.pptm",
    "powerpoint-desktop.potx",
    "powerpoint-desktop.ppsx",
    "powerpoint-desktop.ppsm",
  ])("refuses %s, also renamed to the clean extension", async (fixture) => {
    const bytes = ooxmlFixture(fixture);
    const clean = fixture.startsWith("word")
      ? "a.docx"
      : fixture.startsWith("excel")
        ? "a.xlsx"
        : "a.pptx";
    refusedWith(await upload("editor", [{ name: fixture, bytes }]), "fileType");
    refusedWith(await upload("editor", [{ name: clean, bytes }]), "fileType");
  });

  it("refuses the disguises, the encoded, layout and limit cases", async () => {
    const clean = minimalOfficeEntries("xlsx");
    const cases: Array<[string, Uint8Array]> = [
      ["a fake zip", Buffer.from("PK\u0003\u0004 this is no zip")],
      ["a PDF with an appended zip", Buffer.concat([minimalPdf(), minimalDocx()])],
      [
        "an MZ executable",
        Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000executable", "latin1"),
      ],
      ["HTML", Buffer.from("<!DOCTYPE html><html><script>alert(1)</script></html>")],
      [
        "a clean XLSX plus xl/vbaProject.bin",
        buildZip([...clean, { name: "xl/vbaProject.bin", data: "x" }]),
      ],
      [
        "an encoded macro-enabled declaration",
        buildZip([
          {
            name: "[Content_Types].xml",
            data: contentTypesXml([
              {
                partName: "/xl/workbook.xml",
                contentType:
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
              },
              {
                partName: "/xl/a.bin",
                contentType: "application/vnd.ms-excel.sheet.macro&#69;nabled.12",
              },
            ]),
          },
          ...clean.slice(1),
        ]),
      ],
      ["a prefix before the first entry", buildZip(clean, { prefix: Buffer.from("junk") })],
      ["trailing data", buildZip(clean, { trailing: Buffer.from("junk") })],
      ["an encrypted entry", buildZip(clean.map((e) => ({ ...e, flags: 1 })))],
    ];
    const { bytes, offsets } = buildZipWithOffsets(clean);
    const zip64 = Buffer.from(bytes);
    zip64.writeUInt16LE(0xffff, offsets.end + 10);
    cases.push(["a ZIP64 end record", zip64]);
    const fat = Buffer.alloc(60_000);
    fat.writeUInt16LE(0xcafe, 0);
    fat.writeUInt16LE(60_000 - 4, 2);
    cases.push([
      "an oversized directory",
      buildZip([
        ...clean,
        ...Array.from({ length: 18 }, (_, i) => ({
          name: `x/${i}`,
          data: "",
          method: 0,
          extra: fat,
        })),
      ]),
    ]);
    for (const [label, data] of cases) {
      const res = await upload("editor", [{ name: "file.xlsx", bytes: data }]);
      expect(res.status, label).toBe(400);
      expect(res.body.error?.details, label).toEqual({
        keys: ["file"],
        codes: { file: "fileType" },
      });
    }
  });

  it("caps PDF and Office at 20 MB and images at 5 MB for every role (S3.3)", async () => {
    refusedWith(
      await upload("editor", [{ name: "big.pdf", bytes: minimalPdf(DOCUMENT_MAX_BYTES + 1) }]),
      "fileTooLarge",
    );
    const atCap = await storedRow(
      await upload("editor", [{ name: "big.pdf", bytes: minimalPdf(DOCUMENT_MAX_BYTES) }]),
    );
    expect(atCap?.ext).toBe(".pdf");
    refusedWith(
      await upload("editor", [{ name: "huge.png", bytes: pngOfSize(6 * 1024 * 1024) }]),
      "fileTooLarge",
    );
  });

  it("carries a PDF alone; answers ?id= 403, foreign fields by key, a broken fileInfo by fileInfo", async () => {
    refusedWith(
      await upload("editor", [
        { name: "a.pdf", bytes: minimalPdf() },
        { name: "b.png", bytes: PNG_1PX },
      ]),
      "invalid",
    );
    const replace = await upload("editor", [{ name: "a.pdf", bytes: minimalPdf() }], {}, "?id=1");
    expect(replace.status).toBe(403);
    const ref = await upload("member", [{ name: "a.png", bytes: PNG_1PX }], {
      ref: "api::classified.classified",
      refId: "1",
      field: "images",
    });
    expect(ref.status).toBe(400);
    expect(ref.body.error.details).toEqual({ keys: ["field", "ref", "refId"] });
    for (const fileInfo of ["{", '{"folder":1}']) {
      const res = await upload("member", [{ name: "a.png", bytes: PNG_1PX }], { fileInfo });
      expect(res.status, fileInfo).toBe(400);
      expect(res.body.error.details, fileInfo).toEqual({ keys: ["fileInfo"] });
    }
  });

  it("answers a request without a file with `required`", async () => {
    const res = await fetch(`${t.baseUrl}/api/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${await t.loginAs("member")}` },
      body: new FormData(),
    });
    // No multipart file at all: core never sees a body it could take.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: unknown } };
    expect(body.error.details).toEqual({ keys: ["file"], codes: { file: "required" } });
  });

  it.runIf(engine === "postgres")(
    "infra/diagnostics/upload-census.sql runs read-only and counts",
    async () => {
      const { Client } = requireCmsDependency<{
        Client: new (config: { connectionString: string }) => {
          connect(): Promise<void>;
          query(sql: string): Promise<unknown>;
          end(): Promise<void>;
        };
      }>("pg");
      await storedRow(
        await upload("editor", [
          { name: "census.xlsx", bytes: ooxmlFixture("excel-desktop.xlsx") },
        ]),
      );
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query(`SET search_path TO "${testSchema(t)}"`);
        const sql = readFileSync(
          join(__dirname, "..", "..", "..", "..", "infra", "diagnostics", "upload-census.sql"),
          "utf8",
        );
        const results = (await client.query(sql)) as Array<{
          command: string;
          rows: Array<Record<string, unknown>>;
        }>;
        expect(results[0].command).toBe("BEGIN");
        expect(results[results.length - 1].command).toBe("ROLLBACK");
        const selects = results.filter((result) => result.command === "SELECT");
        expect(selects).toHaveLength(5);
        const [byType, stamps, candidates] = selects.map((result) => result.rows);
        expect(byType.some((row) => row.ext === ".xlsx")).toBe(true);
        expect(Number(stamps[0].stamped)).toBeGreaterThan(0);
        // Every upload of this suite is younger than 24 h: no janitor candidate.
        expect(candidates).toEqual([]);
      } finally {
        await client.end();
      }
    },
  );

  it.runIf(engine === "sqlite")(
    "a body above 50 MB answers 413 before the wrapper (K14)",
    async () => {
      const res = await upload("editor", [
        { name: "huge.pdf", bytes: minimalPdf(51 * 1024 * 1024) },
      ]);
      expect(res.status).toBe(413);
    },
  );
});
