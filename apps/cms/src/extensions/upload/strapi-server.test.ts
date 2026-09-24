/**
 * Hardened POST /api/upload wrapper (FX03) — fake ctx + fake core upload.
 *
 * No Strapi runtime, no disk: the file-system access is injected
 * (createUploadExtension(io)), the core `content-api` controller is a fake
 * factory whose `upload` behaves like @strapi/upload 5.49 for what the
 * wrapper depends on — it dispatches through `this`, persists files
 * sequentially without rollback, emits `media.create` per persisted row
 * and puts the created files on ctx.body.
 */
import { describe, expect, it } from "vitest";

import { MAX_FILE_BYTES } from "../../utils/upload-guard";
import {
  createUploadExtension,
  type IncomingUploadFile,
  type UploadContext,
  type UploadIo,
  type UploadPlugin,
  type UploadStrapi,
} from "./strapi-server";

type Row = Record<string, unknown>;
type Listener = (payload?: unknown) => unknown;

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0];
const SVG = [..."<svg xmlns='"].map((c) => c.charCodeAt(0));
const PDF = [..."%PDF-1.7\n%..."].map((c) => c.charCodeAt(0));

interface FakeDisk {
  [filePath: string]: { head: number[]; size?: unknown; statFails?: boolean; readFails?: boolean };
}

function makeIo(disk: FakeDisk): UploadIo & { statCalls: string[] } {
  const statCalls: string[] = [];
  return {
    statCalls,
    async stat(filePath) {
      statCalls.push(filePath);
      const entry = disk[filePath];
      if (!entry || entry.statFails) throw new Error("ENOENT");
      return { size: entry.size };
    },
    async readHead(filePath, bytes) {
      const entry = disk[filePath];
      if (!entry || entry.readFails) throw new Error("EIO");
      return Uint8Array.from(entry.head.slice(0, bytes));
    },
  };
}

/** Strapi slice: in-memory file table + an eventHub like @strapi/core's. */
function makeStrapi() {
  const listeners = new Map<string, Listener[]>();
  const rows = new Map<number, Row>();
  const errors: string[] = [];
  let failUpdates = false;
  const strapi: UploadStrapi = {
    db: {
      query: (uid) => {
        expect(uid).toBe("plugin::upload.file");
        return {
          findOne: async ({ where }) => rows.get(where.id) ?? null,
          update: async ({ where, data }) => {
            if (failUpdates) throw new Error("db down");
            const next = { ...rows.get(where.id), ...data };
            rows.set(where.id, next);
            return next;
          },
        };
      },
    },
    eventHub: {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    log: { error: (message) => errors.push(message) },
  };
  // @strapi/core event-hub.js: listeners are awaited in registration order.
  const emit = async (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) await listener(payload);
  };
  return {
    strapi,
    rows,
    errors,
    emit,
    failUpdates: () => {
      failUpdates = true;
    },
  };
}

type Env = ReturnType<typeof makeStrapi>;

interface CoreOptions {
  /** Throw when reaching this file index (earlier files stay persisted). */
  failAt?: number;
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
          if (i === options.failAt) throw new Error("File is not a valid image");
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
      // Core `upload` dispatches through `this` (content-api.js:153-162).
      async upload(this: { uploadFiles(ctx: UploadContext): Promise<void> }, ctx: UploadContext) {
        coreCalls.push(ctx);
        await this.uploadFiles(ctx);
      },
    };
    return controller;
  };
  return { factory, coreCalls };
}

type WrappedController = { upload(ctx: UploadContext): Promise<unknown> };

function setup(disk: FakeDisk, options: CoreOptions = {}) {
  const env = makeStrapi();
  const core = makeCoreFactory(env, options);
  const adminFactory = () => ({ upload: async () => "admin" });
  const plugin: UploadPlugin = {
    controllers: { "content-api": core.factory, "admin-upload": adminFactory },
  };
  const io = makeIo(disk);
  createUploadExtension(io)(plugin);
  const wrappedFactory = plugin.controllers["content-api"] as (deps: {
    strapi: UploadStrapi;
  }) => WrappedController;
  const controller = wrappedFactory({ strapi: env.strapi });
  return { env, core, io, plugin, adminFactory, controller };
}

function file(filePath: string, originalFilename: string, size?: unknown): IncomingUploadFile {
  return { filepath: filePath, originalFilename, size, mimetype: "application/octet-stream" };
}

interface CtxOptions {
  files?: IncomingUploadFile | IncomingUploadFile[];
  body?: unknown;
  query?: Record<string, unknown>;
  userId?: unknown;
}

function makeCtx(opts: CtxOptions): UploadContext {
  return {
    query: opts.query ?? {},
    request: {
      body: opts.body ?? {},
      files: opts.files === undefined ? undefined : { files: opts.files },
    },
    state: { user: opts.userId === undefined ? null : { id: opts.userId } },
    forbidden: (message) => `403 ${message}`,
    badRequest: (message) => `400 ${message}`,
  };
}

const uploadedBy = (row: Row | undefined) =>
  (row?.provider_metadata as { uploadedBy?: unknown } | null | undefined)?.uploadedBy;

describe("POST /api/upload wrapper — request guards", () => {
  const disk: FakeDisk = { "/tmp/a": { head: JPEG, size: 1000 } };

  it("rejects ?id (replace / updateFileInfo) before anything else", async () => {
    const { controller, core } = setup(disk);
    const res = await controller.upload(
      makeCtx({ query: { id: "5" }, files: file("/tmp/a", "a.jpg", 1000), userId: 1 }),
    );
    expect(res).toBe("403 Replacing existing files is not allowed via this endpoint");
    expect(core.coreCalls).toHaveLength(0);
  });

  it.each([
    [{ ref: "api::classified.classified", refId: "42", field: "images" }],
    [{ ref: "plugin::users-permissions.user" }],
    [{ refId: "42" }],
    [{ field: "avatar" }],
    [{ path: "../../evil" }],
    [{ fileInfo: "{}", ref: "api::document.document", refId: "1", field: "file" }],
  ])("rejects body %o with 400 and never reaches core", async (body) => {
    const { controller, core } = setup(disk);
    const res = await controller.upload(
      makeCtx({ body, files: file("/tmp/a", "a.jpg", 1000), userId: 1 }),
    );
    expect(res).toBe("400 Only files and fileInfo are accepted by this endpoint");
    expect(core.coreCalls).toHaveLength(0);
  });

  it("accepts fileInfo as the only body key", async () => {
    const { controller, core } = setup(disk);
    await controller.upload(
      makeCtx({
        body: { fileInfo: '{"alternativeText":"x"}' },
        files: file("/tmp/a", "a.jpg", 1000),
        userId: 1,
      }),
    );
    expect(core.coreCalls).toHaveLength(1);
  });

  it("400 without files", async () => {
    const { controller, core } = setup(disk);
    await expect(controller.upload(makeCtx({ userId: 1 }))).resolves.toBe("400 No files provided");
    await expect(controller.upload(makeCtx({ files: [], userId: 1 }))).resolves.toBe(
      "400 No files provided",
    );
    expect(core.coreCalls).toHaveLength(0);
  });

  it("allows 4 files and rejects 5", async () => {
    const many: FakeDisk = {};
    for (let i = 0; i < 5; i++) many[`/tmp/${i}`] = { head: JPEG, size: 10 };
    const four = setup(many);
    await four.controller.upload(
      makeCtx({ files: [0, 1, 2, 3].map((i) => file(`/tmp/${i}`, `${i}.jpg`, 10)), userId: 1 }),
    );
    expect(four.core.coreCalls).toHaveLength(1);

    const five = setup(many);
    const res = await five.controller.upload(
      makeCtx({ files: [0, 1, 2, 3, 4].map((i) => file(`/tmp/${i}`, `${i}.jpg`, 10)), userId: 1 }),
    );
    expect(res).toBe("400 Too many files (max 4 per request)");
    expect(five.core.coreCalls).toHaveLength(0);
  });

  it("rejects a file without a temp path", async () => {
    const { controller } = setup(disk);
    const res = await controller.upload(
      makeCtx({ files: { originalFilename: "x.jpg", size: 10 }, userId: 1 }),
    );
    expect(res).toBe("400 x.jpg could not be validated");
  });
});

describe("POST /api/upload wrapper — size limit", () => {
  it("rejects a declared size over 5 MB without stat", async () => {
    const { controller, io, core } = setup({ "/tmp/big": { head: JPEG } });
    const res = await controller.upload(
      makeCtx({ files: file("/tmp/big", "big.jpg", MAX_FILE_BYTES + 1), userId: 1 }),
    );
    expect(res).toBe("400 big.jpg exceeds the 5 MB limit");
    expect(io.statCalls).toEqual([]);
    expect(core.coreCalls).toHaveLength(0);
  });

  it("falls back to fs.stat when size is missing and rejects over 5 MB", async () => {
    const { controller, io, core } = setup({
      "/tmp/big": { head: JPEG, size: MAX_FILE_BYTES + 1 },
    });
    const res = await controller.upload(makeCtx({ files: file("/tmp/big", "big.jpg"), userId: 1 }));
    expect(res).toBe("400 big.jpg exceeds the 5 MB limit");
    expect(io.statCalls).toEqual(["/tmp/big"]);
    expect(core.coreCalls).toHaveLength(0);
  });

  it("falls back to fs.stat for a non-numeric size and accepts exactly 5 MB", async () => {
    const { controller, io, core } = setup({ "/tmp/ok": { head: JPEG, size: MAX_FILE_BYTES } });
    await controller.upload(makeCtx({ files: file("/tmp/ok", "ok.jpg", "5242880"), userId: 1 }));
    expect(io.statCalls).toEqual(["/tmp/ok"]);
    expect(core.coreCalls).toHaveLength(1);
  });

  it("rejects when stat fails or yields no number (never waved through)", async () => {
    const failing = setup({ "/tmp/x": { head: JPEG, statFails: true } });
    await expect(
      failing.controller.upload(makeCtx({ files: file("/tmp/x", "x.jpg"), userId: 1 })),
    ).resolves.toBe("400 x.jpg could not be validated");
    const weird = setup({ "/tmp/x": { head: JPEG, size: "huge" } });
    await expect(
      weird.controller.upload(makeCtx({ files: file("/tmp/x", "x.jpg"), userId: 1 })),
    ).resolves.toBe("400 x.jpg could not be validated");
    expect(failing.core.coreCalls).toHaveLength(0);
    expect(weird.core.coreCalls).toHaveLength(0);
  });
});

describe("POST /api/upload wrapper — magic bytes and canonical names", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg", "photo.jpg"],
    ["PNG", PNG, "image/png", "photo.png"],
    ["WebP", WEBP, "image/webp", "photo.webp"],
  ])("accepts %s, normalises mimetype and extension", async (_label, head, mime, stored) => {
    const { controller, core } = setup({ "/tmp/p": { head, size: 10 } });
    const upload = file("/tmp/p", "photo.bin", 10);
    await controller.upload(makeCtx({ files: upload, userId: 1 }));
    expect(core.coreCalls).toHaveLength(1);
    expect(upload.mimetype).toBe(mime);
    expect(upload.originalFilename).toBe(stored);
  });

  it.each([
    ["GIF", GIF],
    ["SVG", SVG],
    ["PDF", PDF],
    ["a too-short file", JPEG.slice(0, 5)],
  ])("rejects %s", async (_label, head) => {
    const { controller, core } = setup({ "/tmp/p": { head, size: 10 } });
    const res = await controller.upload(makeCtx({ files: file("/tmp/p", "p.jpg", 10), userId: 1 }));
    expect(res).toBe("400 p.jpg is not an allowed image type (JPEG, PNG or WebP)");
    expect(core.coreCalls).toHaveLength(0);
  });

  it("rejects when the temp file cannot be read", async () => {
    const { controller } = setup({ "/tmp/p": { head: JPEG, size: 10, readFails: true } });
    await expect(
      controller.upload(makeCtx({ files: file("/tmp/p", "p.jpg", 10), userId: 1 })),
    ).resolves.toBe("400 p.jpg is not an allowed image type (JPEG, PNG or WebP)");
  });

  it("rewrites a JPEG-magic x.pdf / x.css to .jpg before core sees it", async () => {
    const { controller, core, env } = setup({
      "/tmp/1": { head: JPEG, size: 10 },
      "/tmp/2": { head: JPEG, size: 10 },
    });
    const pdf = file("/tmp/1", "invoice.pdf", 10);
    const css = file("/tmp/2", "../style.css", 10);
    await controller.upload(makeCtx({ files: [pdf, css], userId: 1 }));
    const seen = core.coreCalls[0].request?.files?.files as IncomingUploadFile[];
    expect(seen.map((f) => [f.originalFilename, f.mimetype])).toEqual([
      ["invoice.jpg", "image/jpeg"],
      ["style.jpg", "image/jpeg"],
    ]);
    expect([...env.rows.values()].map((r) => r.name)).toEqual(["invoice.jpg", "style.jpg"]);
  });

  it("calls the core upload with `this` = controller (dispatch via this.uploadFiles)", async () => {
    const { controller, env } = setup({ "/tmp/p": { head: PNG, size: 10 } });
    await controller.upload(makeCtx({ files: file("/tmp/p", "p.png", 10), userId: 1 }));
    expect(env.rows.size).toBe(1);
  });
});

describe("POST /api/upload wrapper — uploadedBy stamping", () => {
  const disk: FakeDisk = {
    "/tmp/1": { head: JPEG, size: 10 },
    "/tmp/2": { head: PNG, size: 10 },
    "/tmp/3": { head: WEBP, size: 10 },
  };

  it("stamps every created file on success and keeps existing metadata", async () => {
    const { controller, env } = setup(disk);
    const ctx = makeCtx({
      files: [file("/tmp/1", "1.jpg", 10), file("/tmp/2", "2.png", 10)],
      userId: 7,
    });
    await controller.upload(ctx);
    const rows = [...env.rows.values()];
    expect(rows).toHaveLength(2);
    expect(rows.map(uploadedBy)).toEqual([7, 7]);
    expect(rows[0].provider_metadata).toEqual({ existing: "kept", uploadedBy: 7 });
    expect(ctx.body).toHaveLength(2);
  });

  it("stamps the files already persisted when core fails half-way, then rethrows", async () => {
    const { controller, env } = setup(disk, { failAt: 2 });
    const ctx = makeCtx({
      files: [
        file("/tmp/1", "1.jpg", 10),
        file("/tmp/2", "2.png", 10),
        file("/tmp/3", "3.webp", 10),
      ],
      userId: 7,
    });
    await expect(controller.upload(ctx)).rejects.toThrow("File is not a valid image");
    const rows = [...env.rows.values()];
    expect(rows).toHaveLength(2);
    // Janitor-collectable: both persisted files carry the numeric stamp.
    expect(rows.map(uploadedBy)).toEqual([7, 7]);
  });

  it("stamps nothing and rethrows when core fails before persisting", async () => {
    const { controller, env } = setup(disk, { failAt: 0 });
    await expect(
      controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 10), userId: 7 })),
    ).rejects.toThrow("File is not a valid image");
    expect(env.rows.size).toBe(0);
  });

  it("does not stamp without a numeric caller id", async () => {
    for (const userId of [undefined, "7", null]) {
      const { controller, env } = setup(disk);
      await controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 10), userId }));
      expect([...env.rows.values()].map(uploadedBy)).toEqual([undefined]);
    }
  });

  it("ignores media.create outside a wrapped call (admin-panel uploads)", async () => {
    const { controller, env } = setup(disk);
    env.rows.set(1, { id: 1, provider_metadata: null });
    await env.emit("media.create", { media: { id: 1 } });
    await controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 10), userId: 7 }));
    expect(uploadedBy(env.rows.get(1))).toBeUndefined();
  });

  it("keeps interleaved requests apart (each stamps only its own files)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, env } = setup(disk, { gate: () => gate });
    const first = controller.upload(
      makeCtx({ files: [file("/tmp/1", "1.jpg", 10), file("/tmp/2", "2.png", 10)], userId: 7 }),
    );
    const second = controller.upload(makeCtx({ files: file("/tmp/3", "3.webp", 10), userId: 8 }));
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
      controller.upload(makeCtx({ files: file("/tmp/1", "1.jpg", 10), userId: 7 })),
    ).rejects.toThrow("db down");
    expect(env.errors).toHaveLength(1);
    expect(env.errors[0]).toContain("could not stamp uploadedBy");
  });

  it("never masks the core error with a stamping failure", async () => {
    const { controller, env } = setup(disk, { failAt: 1 });
    env.failUpdates();
    await expect(
      controller.upload(
        makeCtx({ files: [file("/tmp/1", "1.jpg", 10), file("/tmp/2", "2.png", 10)], userId: 7 }),
      ),
    ).rejects.toThrow("File is not a valid image");
    expect(env.errors).toHaveLength(1);
  });
});

describe("upload extension — upgrade tripwire", () => {
  it("throws at plugin load when content-api is not a factory", () => {
    const extension = createUploadExtension(makeIo({}));
    expect(() => extension({ controllers: { "content-api": { upload: async () => {} } } })).toThrow(
      /not a controller factory/,
    );
    expect(() => extension({ controllers: {} })).toThrow(/not a controller factory/);
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
    const plugin: UploadPlugin = { controllers: { "content-api": factory } };
    createUploadExtension(makeIo({}))(plugin);
    const wrapped = plugin.controllers["content-api"] as (deps: { strapi?: unknown }) => unknown;
    expect(() => wrapped({})).toThrow(/FX03 tripwire/);
  });

  it("leaves the admin controllers untouched", () => {
    const { plugin, adminFactory } = setup({});
    expect(plugin.controllers["admin-upload"]).toBe(adminFactory);
  });
});
