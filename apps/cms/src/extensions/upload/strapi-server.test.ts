/**
 * Hardened POST /api/upload wrapper (FX03; batch 16 lane 16A, decision 06
 * §E1, contract K14) and the audited upload-service `remove` — fake ctx,
 * fake core upload, in-memory files.
 *
 * No Strapi runtime, no disk: the file-system access is injected
 * (createUploadExtension(io)), the core `content-api` controller is a fake
 * factory whose `upload` behaves like @strapi/upload 5.57 for what the
 * wrapper depends on — it dispatches through `this`, persists files
 * sequentially without rollback, emits `media.create` per persisted row
 * and puts the created files on ctx.body.
 */
import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES } from "@sinnlos/domain";
import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import {
  PNG_1PX,
  minimalDocx,
  minimalPdf,
  ooxmlFixture,
} from "../../integration/upload.test.helper";
import {
  createUploadExtension,
  mapCoreUploadError,
  type IncomingUploadFile,
  type UploadContext,
  type UploadIo,
  type UploadPlugin,
  type UploadStrapi,
} from "./strapi-server";

type Row = Record<string, unknown>;
type Listener = (payload?: unknown) => unknown;

const bytes = (values: number[]) => Uint8Array.from([...values, ...new Array(16).fill(0)]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const PNG = Uint8Array.from(PNG_1PX);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBP")]);
const GIF = Uint8Array.from(Buffer.from("GIF89a\0\0\0\0\0\0\0\0"));
const SVG = Uint8Array.from(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));

interface FakeDisk {
  [filePath: string]: {
    data: Uint8Array;
    size?: unknown;
    statFails?: boolean;
    openFails?: boolean;
  };
}

function makeIo(disk: FakeDisk): UploadIo & { statCalls: string[]; bytesRead: () => number } {
  const statCalls: string[] = [];
  let bytesRead = 0;
  return {
    statCalls,
    bytesRead: () => bytesRead,
    async stat(filePath) {
      statCalls.push(filePath);
      const entry = disk[filePath];
      if (!entry || entry.statFails) throw new Error("ENOENT");
      return { size: entry.size ?? entry.data.length };
    },
    async open(filePath) {
      const entry = disk[filePath];
      if (!entry || entry.openFails) throw new Error("EIO");
      const size = typeof entry.size === "number" ? entry.size : entry.data.length;
      return {
        size,
        // A declared size beyond the data reads as zero bytes (a padded file).
        async read(position: number, length: number) {
          const out = new Uint8Array(Math.max(0, Math.min(length, size - position)));
          out.set(entry.data.subarray(position, position + out.length));
          bytesRead += out.length;
          return out;
        },
        close: async () => undefined,
      };
    },
  };
}

/** Strapi slice: in-memory file table, audit rows, an eventHub like @strapi/core's. */
function makeStrapi() {
  const listeners = new Map<string, Listener[]>();
  const rows = new Map<number, Row>();
  const audit: Row[] = [];
  const errorsLogged: string[] = [];
  let failUpdates = false;
  let failAudit = false;
  let inTransaction = false;
  const strapi = {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: { where: { id: number } }) => rows.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: number }; data: Row }) => {
          if (failUpdates) throw new Error("db down");
          const next = { ...rows.get(where.id), ...data };
          rows.set(where.id, next);
          return next;
        },
        create: async ({ data }: { data: Row }) => {
          expect(uid).toBe("api::audit-event.audit-event");
          if (failAudit) throw new Error("audit insert failed");
          audit.push(data);
          return data;
        },
      }),
      async transaction<T>(callback: (scope: { trx: unknown }) => Promise<T>): Promise<T> {
        inTransaction = true;
        try {
          return await callback({ trx: "trx" });
        } finally {
          inTransaction = false;
        }
      },
      inTransaction: () => inTransaction,
      getConnection: () => {
        const builder = {
          transacting: () => builder,
          where: () => builder,
          select: async () => [{ related_type: "api::classified.classified", related_id: 4 }],
        };
        return builder;
      },
    },
    eventHub: {
      on: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    log: { error: (message: string) => errorsLogged.push(message) },
    requestContext: { get: () => undefined as unknown },
  };
  // @strapi/core event-hub.js: listeners are awaited in registration order.
  const emit = async (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) await listener(payload);
  };
  return {
    strapi: strapi as unknown as UploadStrapi,
    rows,
    audit,
    errors: errorsLogged,
    emit,
    isInTransaction: () => inTransaction,
    failUpdates: () => {
      failUpdates = true;
    },
    failAudit: () => {
      failAudit = true;
    },
  };
}

type Env = ReturnType<typeof makeStrapi>;

interface CoreOptions {
  /** Throw this when reaching this file index (earlier files stay persisted). */
  failAt?: number;
  failWith?: Error;
  /** Await this before persisting each file (interleaving tests). */
  gate?: () => Promise<void>;
}

let nextFileId = 100;

/** Fake @strapi/upload content-api controller factory. */
function makeCoreFactory(env: Env, options: CoreOptions = {}) {
  const coreCalls: UploadContext[] = [];
  const factory = () => {
    const controller = {
      async uploadFiles(ctx: UploadContext) {
        const files = ctx.request?.files?.files;
        const list = Array.isArray(files) ? files : files ? [files] : [];
        const created: Row[] = [];
        for (let i = 0; i < list.length; i++) {
          if (options.gate) await options.gate();
          if (i === options.failAt) throw options.failWith ?? new Error("disk full");
          const id = nextFileId++;
          const row: Row = {
            id,
            name: list[i].originalFilename,
            mime: list[i].mimetype,
            provider_metadata: i === 0 ? { existing: "kept" } : null,
          };
          env.rows.set(id, row);
          await env.emit("media.create", { media: { id, name: row.name } });
          created.push({ id, name: row.name, mime: row.mime });
        }
        ctx.body = created;
      },
      async replaceFile() {
        throw new Error("replaceFile must never be reached");
      },
      async updateFileInfo() {
        throw new Error("updateFileInfo must never be reached");
      },
      // Core `upload` dispatches through `this` (content-api.js).
      async upload(this: { uploadFiles(ctx: UploadContext): Promise<void> }, ctx: UploadContext) {
        coreCalls.push(ctx);
        await this.uploadFiles(ctx);
      },
    };
    return controller;
  };
  return { factory, coreCalls };
}

/** Fake upload service factory: remove deletes the row (and records the call). */
function makeServiceFactory(env: Env) {
  const removed: Row[] = [];
  const inTransaction: boolean[] = [];
  const factory = () => ({
    async remove(file: Row) {
      inTransaction.push(env.isInTransaction());
      removed.push(file);
      env.rows.delete(file.id as number);
      return file;
    },
    other: () => "untouched",
  });
  return { factory, removed, inTransaction };
}

type WrappedController = { upload(ctx: UploadContext): Promise<unknown> };

function setup(disk: FakeDisk, options: CoreOptions = {}) {
  const env = makeStrapi();
  const core = makeCoreFactory(env, options);
  const service = makeServiceFactory(env);
  const adminFactory = () => ({ upload: async () => "admin" });
  const plugin: UploadPlugin = {
    controllers: { "content-api": core.factory, "admin-upload": adminFactory },
    services: { upload: service.factory },
  };
  const io = makeIo(disk);
  createUploadExtension(io)(plugin);
  const wrappedFactory = plugin.controllers["content-api"] as (deps: {
    strapi: UploadStrapi;
  }) => WrappedController;
  const controller = wrappedFactory({ strapi: env.strapi });
  return { env, core, io, plugin, service, adminFactory, controller };
}

function file(filePath: string, originalFilename: string, size?: unknown): IncomingUploadFile {
  return { filepath: filePath, originalFilename, size, mimetype: "application/octet-stream" };
}

interface CtxOptions {
  files?: IncomingUploadFile | IncomingUploadFile[];
  body?: unknown;
  query?: Record<string, unknown>;
  userId?: unknown;
  role?: string;
}

function makeCtx(opts: CtxOptions): UploadContext {
  return {
    query: opts.query ?? {},
    request: {
      body: opts.body ?? {},
      files: opts.files === undefined ? undefined : { files: opts.files },
    },
    state: {
      user:
        opts.userId === undefined
          ? null
          : { id: opts.userId, role: { type: opts.role ?? "member" } },
    },
  };
}

/** The thrown refusal's status and details. */
async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { name?: string; details?: unknown; message?: string };
    return { name: e.name, details: e.details, message: e.message };
  }
  return null;
}

const fileCode = (code: string) => ({
  name: "ValidationError",
  details: { keys: ["file"], codes: { file: code } },
});

const uploadedBy = (row: Row | undefined) =>
  (row?.provider_metadata as { uploadedBy?: unknown } | null | undefined)?.uploadedBy;

describe("POST /api/upload wrapper — request guards", () => {
  const disk: FakeDisk = { "/tmp/a": { data: JPEG } };

  it("refuses ?id (replace / updateFileInfo) with 403 before anything else", async () => {
    const { controller, core } = setup(disk);
    const refusal = await refusalOf(
      controller.upload(
        makeCtx({ query: { id: "5" }, files: file("/tmp/a", "a.jpg", 20), userId: 1 }),
      ),
    );
    expect(refusal?.name).toBe("ForbiddenError");
    expect(core.coreCalls).toHaveLength(0);
  });

  it.each([
    [
      { ref: "api::classified.classified", refId: "42", field: "images" },
      ["field", "ref", "refId"],
    ],
    [{ ref: "plugin::users-permissions.user" }, ["ref"]],
    [{ path: "../../evil" }, ["path"]],
    [
      { fileInfo: "{}", ref: "api::document.document", refId: "1", field: "file" },
      ["field", "ref", "refId"],
    ],
  ])("refuses body %o by its keys and never reaches core", async (body, keys) => {
    const { controller, core } = setup(disk);
    const refusal = await refusalOf(
      controller.upload(makeCtx({ body, files: file("/tmp/a", "a.jpg", 20), userId: 1 })),
    );
    expect(refusal).toMatchObject({ name: "ValidationError", details: { keys } });
    expect(core.coreCalls).toHaveLength(0);
  });

  it("refuses a malformed fileInfo with details.keys fileInfo (core would answer 500)", async () => {
    for (const fileInfo of ["{", '{"folder":1}', '{"caption":3}', "[]"]) {
      const { controller, core } = setup(disk);
      const refusal = await refusalOf(
        controller.upload(
          makeCtx({ body: { fileInfo }, files: file("/tmp/a", "a.jpg", 20), userId: 1 }),
        ),
      );
      expect(refusal, fileInfo).toMatchObject({
        name: "ValidationError",
        details: { keys: ["fileInfo"] },
      });
      expect(core.coreCalls).toHaveLength(0);
    }
  });

  it("drops fileInfo.name and hands core the checked fileInfo", async () => {
    const { controller, core } = setup(disk);
    await controller.upload(
      makeCtx({
        body: { fileInfo: '{"name":"evil.html","alternativeText":"x"}' },
        files: file("/tmp/a", "a.jpg", 20),
        userId: 1,
      }),
    );
    expect(core.coreCalls[0].request?.body).toEqual({ fileInfo: { alternativeText: "x" } });
  });

  it("refuses a request without files as `required`", async () => {
    const { controller, core } = setup(disk);
    expect(await refusalOf(controller.upload(makeCtx({ userId: 1 })))).toMatchObject(
      fileCode("required"),
    );
    expect(await refusalOf(controller.upload(makeCtx({ files: [], userId: 1 })))).toMatchObject(
      fileCode("required"),
    );
    expect(core.coreCalls).toHaveLength(0);
  });

  it("allows 4 images and refuses 5 as `invalid`", async () => {
    const many: FakeDisk = {};
    for (let i = 0; i < 5; i++) many[`/tmp/${i}`] = { data: JPEG };
    const four = setup(many);
    await four.controller.upload(
      makeCtx({ files: [0, 1, 2, 3].map((i) => file(`/tmp/${i}`, `${i}.jpg`, 20)), userId: 1 }),
    );
    expect(four.core.coreCalls).toHaveLength(1);
    const five = setup(many);
    const refusal = await refusalOf(
      five.controller.upload(
        makeCtx({
          files: [0, 1, 2, 3, 4].map((i) => file(`/tmp/${i}`, `${i}.jpg`, 20)),
          userId: 1,
        }),
      ),
    );
    expect(refusal).toMatchObject(fileCode("invalid"));
    expect(five.core.coreCalls).toHaveLength(0);
  });

  it("refuses a file without a temp path, or one that cannot be opened, as `invalid`", async () => {
    const { controller } = setup({ "/tmp/x": { data: JPEG, openFails: true } });
    expect(
      await refusalOf(
        controller.upload(makeCtx({ files: { originalFilename: "x.jpg", size: 10 }, userId: 1 })),
      ),
    ).toMatchObject(fileCode("invalid"));
    expect(
      await refusalOf(
        controller.upload(makeCtx({ files: file("/tmp/x", "x.jpg", 20), userId: 1 })),
      ),
    ).toMatchObject(fileCode("invalid"));
  });
});

describe("POST /api/upload wrapper — the profiles by role", () => {
  const disk: FakeDisk = {
    "/tmp/pdf": { data: minimalPdf() },
    "/tmp/docx": { data: minimalDocx() },
    "/tmp/xlsx": { data: ooxmlFixture("excel-desktop.xlsx") },
    "/tmp/xlsm": { data: ooxmlFixture("excel-desktop.xlsm") },
    "/tmp/png": { data: PNG },
  };

  it.each(["admin_role", "editor", "department_head"])(
    "%s may upload PDF and Office files, stored by content",
    async (role) => {
      for (const [path, name, mime, stored] of [
        ["/tmp/pdf", "scan.png", "application/pdf", "scan.pdf"],
        [
          "/tmp/docx",
          "memo.doc",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "memo.docx",
        ],
        [
          "/tmp/xlsx",
          "plan.xlsm",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "plan.xlsx",
        ],
      ]) {
        const { controller, core } = setup(disk);
        const upload = file(path, name, 0);
        upload.size = (disk[path].data as Uint8Array).length;
        await controller.upload(makeCtx({ files: upload, userId: 3, role }));
        expect(core.coreCalls, `${role} ${name}`).toHaveLength(1);
        expect([upload.mimetype, upload.originalFilename]).toEqual([mime, stored]);
      }
    },
  );

  it.each(["team_lead", "member", "guest", "authenticated"])(
    "%s keeps the image profile: a PDF or XLSX is refused, a PNG accepted",
    async (role) => {
      for (const path of ["/tmp/pdf", "/tmp/xlsx"]) {
        const { controller, core } = setup(disk);
        const refusal = await refusalOf(
          controller.upload(makeCtx({ files: file(path, "x.pdf", 100), userId: 3, role })),
        );
        expect(refusal, `${role} ${path}`).toMatchObject(fileCode("fileType"));
        expect(core.coreCalls).toHaveLength(0);
      }
      const { controller, core } = setup(disk);
      await controller.upload(makeCtx({ files: file("/tmp/png", "x.png", 70), userId: 3, role }));
      expect(core.coreCalls).toHaveLength(1);
    },
  );

  it("refuses a macro-enabled workbook for an editor, whatever its name", async () => {
    const { controller, core } = setup(disk);
    const refusal = await refusalOf(
      controller.upload(
        makeCtx({ files: file("/tmp/xlsm", "plan.xlsx", 9340), userId: 3, role: "editor" }),
      ),
    );
    expect(refusal).toMatchObject(fileCode("fileType"));
    expect(core.coreCalls).toHaveLength(0);
  });

  it("carries a PDF or Office file alone: with a second file the request is `invalid`", async () => {
    const { controller, core } = setup(disk);
    const refusal = await refusalOf(
      controller.upload(
        makeCtx({
          files: [file("/tmp/pdf", "a.pdf", 200), file("/tmp/png", "b.png", 70)],
          userId: 3,
          role: "editor",
        }),
      ),
    );
    expect(refusal).toMatchObject(fileCode("invalid"));
    expect(core.coreCalls).toHaveLength(0);
  });
});

describe("POST /api/upload wrapper — sizes, before any read", () => {
  it("refuses a declared size over the profile's cap without stat or read", async () => {
    const image = setup({ "/tmp/big": { data: JPEG } });
    expect(
      await refusalOf(
        image.controller.upload(
          makeCtx({ files: file("/tmp/big", "big.jpg", IMAGE_MAX_BYTES + 1), userId: 1 }),
        ),
      ),
    ).toMatchObject(fileCode("fileTooLarge"));
    expect(image.io.statCalls).toEqual([]);
    expect(image.io.bytesRead()).toBe(0);
    const document = setup({ "/tmp/big": { data: minimalPdf() } });
    expect(
      await refusalOf(
        document.controller.upload(
          makeCtx({
            files: file("/tmp/big", "big.pdf", DOCUMENT_MAX_BYTES + 1),
            userId: 1,
            role: "editor",
          }),
        ),
      ),
    ).toMatchObject(fileCode("fileTooLarge"));
    expect(document.io.bytesRead()).toBe(0);
  });

  it("caps images at 5 MB for the document profile too (an editor's 6 MB PNG)", async () => {
    const { controller } = setup({ "/tmp/png": { data: PNG, size: 6 * 1024 * 1024 } });
    expect(
      await refusalOf(
        controller.upload(
          makeCtx({ files: file("/tmp/png", "x.png", 6 * 1024 * 1024), userId: 1, role: "editor" }),
        ),
      ),
    ).toMatchObject(fileCode("fileTooLarge"));
  });

  it("accepts exactly 20 MB for a PDF and 5 MB for an image", async () => {
    const pdf = setup({ "/tmp/pdf": { data: minimalPdf(), size: DOCUMENT_MAX_BYTES } });
    await pdf.controller.upload(
      makeCtx({ files: file("/tmp/pdf", "x.pdf", DOCUMENT_MAX_BYTES), userId: 1, role: "editor" }),
    );
    expect(pdf.core.coreCalls).toHaveLength(1);
    const png = setup({ "/tmp/png": { data: PNG, size: IMAGE_MAX_BYTES } });
    await png.controller.upload(
      makeCtx({ files: file("/tmp/png", "x.png", IMAGE_MAX_BYTES), userId: 1 }),
    );
    expect(png.core.coreCalls).toHaveLength(1);
  });

  it("falls back to fs.stat for a missing or non-numeric size; never waves one through", async () => {
    const ok = setup({ "/tmp/ok": { data: JPEG } });
    await ok.controller.upload(makeCtx({ files: file("/tmp/ok", "ok.jpg", "20"), userId: 1 }));
    expect(ok.io.statCalls).toEqual(["/tmp/ok"]);
    expect(ok.core.coreCalls).toHaveLength(1);
    const failing = setup({ "/tmp/x": { data: JPEG, statFails: true } });
    expect(
      await refusalOf(
        failing.controller.upload(makeCtx({ files: file("/tmp/x", "x.jpg"), userId: 1 })),
      ),
    ).toMatchObject(fileCode("invalid"));
    const weird = setup({ "/tmp/x": { data: JPEG, size: "huge" } });
    expect(
      await refusalOf(
        weird.controller.upload(makeCtx({ files: file("/tmp/x", "x.jpg"), userId: 1 })),
      ),
    ).toMatchObject(fileCode("invalid"));
  });
});

describe("POST /api/upload wrapper — magic bytes and canonical names", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg", "photo.jpg"],
    ["PNG", PNG, "image/png", "photo.png"],
    ["WebP", WEBP, "image/webp", "photo.webp"],
  ])("accepts %s, normalises mimetype and extension", async (_label, data, mime, stored) => {
    const { controller, core } = setup({ "/tmp/p": { data } });
    const upload = file("/tmp/p", "photo.bin", 20);
    await controller.upload(makeCtx({ files: upload, userId: 1 }));
    expect(core.coreCalls).toHaveLength(1);
    expect(upload.mimetype).toBe(mime);
    expect(upload.originalFilename).toBe(stored);
  });

  it.each([
    ["GIF", GIF],
    ["SVG", SVG],
    ["a too-short file", JPEG.slice(0, 5)],
  ])("refuses %s as fileType", async (_label, data) => {
    const { controller, core } = setup({ "/tmp/p": { data } });
    expect(
      await refusalOf(
        controller.upload(
          makeCtx({ files: file("/tmp/p", "p.jpg", 10), userId: 1, role: "editor" }),
        ),
      ),
    ).toMatchObject(fileCode("fileType"));
    expect(core.coreCalls).toHaveLength(0);
  });

  it("rewrites a JPEG-magic x.pdf / x.css to .jpg before core sees it", async () => {
    const { controller, core, env } = setup({ "/tmp/1": { data: JPEG }, "/tmp/2": { data: JPEG } });
    const pdf = file("/tmp/1", "invoice.pdf", 20);
    const css = file("/tmp/2", "../style.css", 20);
    await controller.upload(makeCtx({ files: [pdf, css], userId: 1 }));
    const seen = core.coreCalls[0].request?.files?.files as IncomingUploadFile[];
    expect(seen.map((f) => [f.originalFilename, f.mimetype])).toEqual([
      ["invoice.jpg", "image/jpeg"],
      ["style.jpg", "image/jpeg"],
    ]);
    expect([...env.rows.values()].map((r) => r.name)).toEqual(["invoice.jpg", "style.jpg"]);
  });
});

describe("POST /api/upload wrapper — core's own refusals in the K14 shape", () => {
  const disk: FakeDisk = { "/tmp/1": { data: JPEG }, "/tmp/2": { data: PNG } };

  it.each([
    [
      "a type refusal (ValidationError without details)",
      new errors.ValidationError("File type 'x' is not allowed"),
      fileCode("fileType"),
    ],
    [
      "a faulty image",
      new errors.ApplicationError("File is not a valid image"),
      fileCode("fileType"),
    ],
    [
      "core's size limit",
      new errors.PayloadTooLargeError("x exceeds size limit"),
      fileCode("fileTooLarge"),
    ],
    [
      "a name core refuses",
      new errors.ApplicationError("File name contains invalid characters"),
      fileCode("invalid"),
    ],
  ])("maps %s", async (_label, error, expected) => {
    const { controller } = setup(disk, { failAt: 0, failWith: error });
    expect(
      await refusalOf(
        controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 20), userId: 7 })),
      ),
    ).toMatchObject(expected);
  });

  it("maps core's fileInfo schema refusal to fileInfo", () => {
    const yup = new errors.ValidationError("fileInfo.x is invalid", { errors: [{ path: ["x"] }] });
    expect(mapCoreUploadError(yup)).toMatchObject({ details: { keys: ["fileInfo"] } });
    expect(mapCoreUploadError(new SyntaxError("Unexpected token"))).toMatchObject({
      details: { keys: ["fileInfo"] },
    });
  });

  it("leaves operational failures alone (a 5xx)", async () => {
    const { controller } = setup(disk, {
      failAt: 0,
      failWith: new Error("EACCES: permission denied"),
    });
    await expect(
      controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 20), userId: 7 })),
    ).rejects.toThrow("EACCES");
  });
});

describe("POST /api/upload wrapper — uploadedBy stamping", () => {
  const disk: FakeDisk = {
    "/tmp/1": { data: JPEG },
    "/tmp/2": { data: PNG },
    "/tmp/3": { data: WEBP },
  };

  it("stamps every created file on success and keeps existing metadata", async () => {
    const { controller, env } = setup(disk);
    const ctx = makeCtx({
      files: [file("/tmp/1", "1.jpg", 20), file("/tmp/2", "2.png", 70)],
      userId: 7,
    });
    await controller.upload(ctx);
    const rows = [...env.rows.values()];
    expect(rows.map(uploadedBy)).toEqual([7, 7]);
    expect(rows[0].provider_metadata).toEqual({ existing: "kept", uploadedBy: 7 });
    expect(ctx.body).toHaveLength(2);
  });

  it("stamps the files already persisted when core fails half-way, then rethrows (mapped)", async () => {
    const { controller, env } = setup(disk, {
      failAt: 2,
      failWith: new errors.ApplicationError("File is not a valid image"),
    });
    const ctx = makeCtx({
      files: [
        file("/tmp/1", "1.jpg", 20),
        file("/tmp/2", "2.png", 70),
        file("/tmp/3", "3.webp", 20),
      ],
      userId: 7,
    });
    expect(await refusalOf(controller.upload(ctx))).toMatchObject(fileCode("fileType"));
    expect([...env.rows.values()].map(uploadedBy)).toEqual([7, 7]);
  });

  it("does not stamp without a numeric caller id", async () => {
    for (const userId of ["7", null]) {
      const { controller, env } = setup(disk);
      await controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 20), userId }));
      expect([...env.rows.values()].map(uploadedBy)).toEqual([undefined]);
    }
  });

  it("ignores media.create outside a wrapped call (admin-panel uploads)", async () => {
    const { controller, env } = setup(disk);
    env.rows.set(1, { id: 1, provider_metadata: null });
    await env.emit("media.create", { media: { id: 1 } });
    await controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 20), userId: 7 }));
    expect(uploadedBy(env.rows.get(1))).toBeUndefined();
  });

  it("keeps interleaved requests apart (each stamps only its own files)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, env } = setup(disk, { gate: () => gate });
    const first = controller.upload(
      makeCtx({ files: [file("/tmp/1", "1.jpg", 20), file("/tmp/2", "2.png", 70)], userId: 7 }),
    );
    const second = controller.upload(makeCtx({ files: file("/tmp/3", "3.webp", 20), userId: 8 }));
    release();
    await Promise.all([first, second]);
    const byName = new Map([...env.rows.values()].map((r) => [r.name, uploadedBy(r)]));
    expect(byName).toEqual(
      new Map<unknown, unknown>([
        ["1.jpg", 7],
        ["2.png", 7],
        ["3.webp", 8],
      ]),
    );
  });

  it("surfaces and logs a stamping failure on an otherwise successful upload", async () => {
    const { controller, env } = setup(disk);
    env.failUpdates();
    await expect(
      controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 20), userId: 7 })),
    ).rejects.toThrow("db down");
    expect(env.errors[0]).toContain("could not stamp uploadedBy");
  });
});

describe("the upload service's remove records the delete (delete trail)", () => {
  const serviceOf = (plugin: UploadPlugin, env: Env) =>
    (
      plugin.services?.upload as (deps: { strapi: UploadStrapi }) => {
        remove(file: Row): Promise<unknown>;
        other(): string;
      }
    )({ strapi: env.strapi });

  it("writes the audit row and removes in one transaction", async () => {
    const { plugin, env, service } = setup({});
    env.rows.set(9, { id: 9 });
    await serviceOf(plugin, env).remove({
      id: 9,
      documentId: "f9",
      name: "flyer.pdf",
      mime: "application/pdf",
      size: 12.3,
    });
    expect(service.removed).toHaveLength(1);
    expect(service.inTransaction).toEqual([true]);
    expect(env.audit).toEqual([
      expect.objectContaining({
        action: "delete",
        targetUid: "plugin::upload.file",
        targetDocumentId: "f9",
        actorKind: "system",
        source: "system",
        detail:
          "file 9, application/pdf, 12300 B, linked by api::classified.classified#4: flyer.pdf",
      }),
    ]);
    expect(serviceOf(plugin, env).other()).toBe("untouched");
  });

  it("removes nothing when the audit insert fails", async () => {
    const { plugin, env, service } = setup({});
    env.failAudit();
    await expect(serviceOf(plugin, env).remove({ id: 9, documentId: "f9" })).rejects.toThrow(
      "audit insert failed",
    );
    expect(service.removed).toHaveLength(0);
  });
});

describe("upload extension — upgrade tripwire", () => {
  const services = () => ({ upload: () => ({ remove: async () => undefined }) });

  it("throws at plugin load when content-api is not a factory", () => {
    const extension = createUploadExtension(makeIo({}));
    expect(() =>
      extension({
        controllers: { "content-api": { upload: async () => {} } },
        services: services(),
      }),
    ).toThrow(/not a controller factory/);
    expect(() => extension({ controllers: {}, services: services() })).toThrow(
      /not a controller factory/,
    );
  });

  it("throws at plugin load when the upload service is not a factory, and when remove is gone", () => {
    const env = makeStrapi();
    const { factory } = makeCoreFactory(env);
    expect(() =>
      createUploadExtension(makeIo({}))({ controllers: { "content-api": factory }, services: {} }),
    ).toThrow(/delete-audit tripwire/);
    const plugin: UploadPlugin = {
      controllers: { "content-api": factory },
      services: { upload: () => ({}) },
    };
    createUploadExtension(makeIo({}))(plugin);
    expect(() =>
      (plugin.services?.upload as (deps: { strapi: UploadStrapi }) => unknown)({
        strapi: env.strapi,
      }),
    ).toThrow(/remove\(file\)/);
  });

  it.each(["upload", "uploadFiles", "replaceFile", "updateFileInfo"])(
    "throws at controller instantiation when %s is missing",
    (method) => {
      const env = makeStrapi();
      const { factory } = makeCoreFactory(env);
      const plugin: UploadPlugin = {
        controllers: {
          "content-api": () => {
            const controller: Record<string, unknown> = { ...factory() };
            delete controller[method];
            return controller;
          },
        },
        services: services(),
      };
      createUploadExtension(makeIo({}))(plugin);
      const wrapped = plugin.controllers["content-api"] as (deps: {
        strapi: UploadStrapi;
      }) => unknown;
      expect(() => wrapped({ strapi: env.strapi })).toThrow(new RegExp(`exposes ${method}`));
    },
  );

  it("throws when the factory gets no usable strapi", () => {
    const env = makeStrapi();
    const { factory } = makeCoreFactory(env);
    const plugin: UploadPlugin = { controllers: { "content-api": factory }, services: services() };
    createUploadExtension(makeIo({}))(plugin);
    const wrapped = plugin.controllers["content-api"] as (deps: { strapi?: unknown }) => unknown;
    expect(() => wrapped({})).toThrow(/FX03 tripwire/);
  });

  it("leaves the admin controllers untouched", () => {
    const { plugin, adminFactory } = setup({});
    expect(plugin.controllers["admin-upload"]).toBe(adminFactory);
  });
});
