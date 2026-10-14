import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_FORMATS, UPLOAD_FORMAT_SPECS } from "@sinnlos/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pluginsConfig from "../../../config/plugins";
import {
  buildZip,
  minimalOfficeEntries,
  minimalPdf,
  ooxmlFixture,
  PNG_1PX,
} from "../../integration/upload.test.helper";
import {
  requireFromPackage,
  requirePackageFile,
  strapiPackageDir,
  strapiPackageVersion,
} from "../../test/sqlite-engine.test.helper";

/**
 * What the upload profile (extensions/upload/strapi-server.ts) and the
 * admin-panel backstop (config/plugins.ts) rely on in @strapi/upload 5.57.0
 * and the file-type it loads (batch 16 plan S6, lane 16A item 0; decision
 * 06 C17, C36, C37, amendment row A10). Re-pinned on 5.57, which
 * restructured validateFile (a "trusted declaration" branch, the zip
 * exception moved). A Strapi bump that breaks any of these needs a look at
 * the wrapper and the backstop first.
 */

const uploadDir = () => strapiPackageDir("@strapi/upload");

interface ValidationResult {
  isValid: boolean;
  detectedMime?: string;
  error?: { message: string };
}

type ValidateFile = (
  file: { filepath: string; originalFilename: string; mimetype: string },
  config: { deniedTypes?: string[]; allowedTypes?: string[] },
  strapi: { log: { warn(): void } },
) => Promise<ValidationResult>;

const mimeValidation = () =>
  requirePackageFile<{ validateFile: ValidateFile }>(
    uploadDir(),
    "dist/server/utils/mime-validation.js",
  );

const source = (relative: string) => readFileSync(join(uploadDir(), relative), "utf8");

const deniedTypes = (): string[] =>
  pluginsConfig({
    env: Object.assign((_key: string, def?: unknown) => def, {
      int: (_key: string, def?: number) => def as number,
      bool: (_key: string, def?: boolean) => def as boolean,
      array: (_key: string, def?: string[]) => def as string[],
    }),
  }).upload.config.security.deniedTypes;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sinnlos-upload-contract-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
async function validate(
  bytes: Uint8Array,
  originalFilename: string,
  mimetype: string,
  config: { deniedTypes?: string[] } = { deniedTypes: deniedTypes() },
): Promise<ValidationResult> {
  const filepath = join(dir, `f${counter++}`);
  writeFileSync(filepath, bytes);
  return mimeValidation().validateFile({ filepath, originalFilename, mimetype }, config, {
    log: { warn: () => undefined },
  });
}

const XLSX = UPLOAD_FORMAT_SPECS.xlsx.mime;

describe("installed versions", () => {
  it("@strapi/upload 5.57.0 with file-type 21.3.4 and mime-types 2.1.35", () => {
    expect(strapiPackageVersion("@strapi/upload")).toBe("5.57.0");
    // @strapi/upload's own dependencies, next to it in the pnpm store (file-type
    // exports no package.json).
    const own = (name: string) =>
      (
        JSON.parse(readFileSync(join(uploadDir(), "..", "..", name, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
    expect(own("file-type")).toBe("21.3.4");
    expect(own("mime-types")).toBe("2.1.35");
  });
});

describe("C17: validateFile sniffs the first 4100 bytes only", () => {
  it("reads a 4100-byte chunk", () => {
    expect(source("dist/server/utils/mime-validation.js")).toContain(
      "async function readFileChunk(filePath, chunkSize = 4100)",
    );
    expect(source("dist/server/utils/mime-validation.js")).toContain(
      "readFileChunk(filePath, 4100)",
    );
  });

  it("KNOWN: a macro-enabled package whose [Content_Types].xml lies beyond 4100 bytes passes as .xlsx", async () => {
    const macro = minimalOfficeEntries("xlsx", {
      contentTypes:
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    });
    const padded = buildZip([
      { name: "docProps/pad.bin", data: Buffer.alloc(5000, 7), method: 0 },
      ...macro,
    ]);
    const result = await validate(padded, "x.xlsx", XLSX);
    expect(result).toMatchObject({ isValid: true, detectedMime: XLSX });
  });
});

describe("C36: deniedTypes binds the declared, the extension's and the detected type", () => {
  it("matches the three patterns case-insensitively with wildcards", async () => {
    // The declared type.
    expect(
      await validate(PNG_1PX, "x.bin", "application/vnd.MS-EXCEL.sheet.macroEnabled.12"),
    ).toMatchObject({ isValid: false });
    // The extension's type.
    for (const ext of [
      ".xlsm",
      ".docm",
      ".pptm",
      ".xltm",
      ".dotm",
      ".potm",
      ".ppsm",
      ".xlam",
      ".xlsb",
    ]) {
      expect(await validate(PNG_1PX, `x${ext}`, "application/octet-stream"), ext).toMatchObject({
        isValid: false,
      });
    }
    // The detected type: a real .xlsm renamed .xlsx (its [Content_Types].xml is in the window).
    const renamed = await validate(ooxmlFixture("excel-desktop.xlsm"), "x.xlsx", XLSX);
    expect(renamed.isValid).toBe(false);
    expect(renamed.error?.message).toMatch(/macroenabled/i);
  });

  it("KNOWN (amendment row A10): a real .xlsb renamed .xlsx passes as XLSX", async () => {
    const result = await validate(ooxmlFixture("excel-desktop.xlsb"), "x.xlsx", XLSX);
    expect(result).toMatchObject({ isValid: true, detectedMime: XLSX });
  });
});

describe("the profile's canonical files pass validateFile with the table's mime", () => {
  const accepted: Array<[string, Uint8Array, (typeof UPLOAD_FORMATS)[number]]> = [
    ["word-desktop.docx", ooxmlFixture("word-desktop.docx"), "docx"],
    ["excel-desktop.xlsx", ooxmlFixture("excel-desktop.xlsx"), "xlsx"],
    ["powerpoint-desktop.pptx", ooxmlFixture("powerpoint-desktop.pptx"), "pptx"],
    ["python-zipfile-streamed.xlsx", ooxmlFixture("python-zipfile-streamed.xlsx"), "xlsx"],
    ["minimal.pdf", minimalPdf(), "pdf"],
    ["1px.png", PNG_1PX, "png"],
  ];

  it.each(accepted)("%s", async (_name, bytes, format) => {
    const spec = UPLOAD_FORMAT_SPECS[format];
    const result = await validate(bytes, `file${spec.extension}`, spec.mime);
    expect(result).toMatchObject({ isValid: true, detectedMime: spec.mime });
  });

  it("mime-types maps every stored extension to its stored mime", () => {
    const mimeTypes = requireFromPackage<{ lookup(ext: string): string | false }>(
      uploadDir(),
      "mime-types",
    );
    for (const format of UPLOAD_FORMATS) {
      const spec = UPLOAD_FORMAT_SPECS[format];
      expect(mimeTypes.lookup(spec.extension), format).toBe(spec.mime);
    }
  });
});

describe("what the wrapper maps after the core", () => {
  const upload = () => source("dist/server/services/upload.js");
  const controller = () => source("dist/server/controllers/content-api.js");

  it("core prefers fileInfo.name over the file name (the wrapper drops it)", () => {
    expect(upload()).toContain("const usedName = (fileInfo.name || filename).normalize();");
  });

  it("core refuses with these errors, which the wrapper maps to fileType, invalid and fileTooLarge", () => {
    expect(upload()).toContain("throw new ApplicationError('File is not a valid image')");
    expect(upload()).toContain(
      "throw new ApplicationError('File name contains invalid characters')",
    );
    expect(source("dist/server/register.js")).toContain("throw new PayloadTooLargeError(");
    // An all-refused request: a ValidationError without details.
    expect(controller()).toContain(
      "throw new utils.errors.ValidationError(validationErrors[0].message);",
    );
  });

  it("core JSON-parses fileInfo strings unguarded (a SyntaxError would be a 500)", () => {
    expect(source("dist/server/utils/mime-validation.js")).toContain(
      "parsedFileInfo = JSON.parse(body.fileInfo);",
    );
  });

  it("core's fileInfo schema takes exactly name, alternativeText, caption, focalPoint", () => {
    const schema = source("dist/server/controllers/validation/content-api/upload.js");
    for (const key of ["name:", "alternativeText:", "caption:", "focalPoint:", ".noUnknown()"]) {
      expect(schema).toContain(key);
    }
  });

  it("remove deletes the bytes before the row (hence the tombstone of claimAndRemove)", () => {
    const remove = upload().slice(upload().indexOf("async function remove(file)"));
    expect(remove.indexOf("provider.delete(file)")).toBeGreaterThan(-1);
    expect(remove.indexOf("provider.delete(file)")).toBeLessThan(remove.indexOf(".delete({"));
  });
});

describe("the local provider deletes missing bytes without an error (claimAndRemove retries)", () => {
  it("resolves for a file that is already gone", async () => {
    const publicDir = join(dir, "public");
    mkdirSync(join(publicDir, "uploads"), { recursive: true });
    const provider = requireFromPackage<{
      init(options: object): { delete(file: { hash: string; ext: string }): Promise<unknown> };
    }>(uploadDir(), "@strapi/provider-upload-local");
    const previous = (globalThis as { strapi?: unknown }).strapi;
    (globalThis as { strapi?: unknown }).strapi = { dirs: { static: { public: publicDir } } };
    try {
      const instance = provider.init({});
      await expect(instance.delete({ hash: "gone_abc", ext: ".pdf" })).resolves.toBeDefined();
    } finally {
      (globalThis as { strapi?: unknown }).strapi = previous;
    }
  });
});
