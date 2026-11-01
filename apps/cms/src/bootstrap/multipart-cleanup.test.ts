import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireFromPackage,
  requirePackageFile,
  strapiPackageDir,
} from "../test/sqlite-engine.test.helper";
import {
  CLOSE_WAIT_MS,
  MAX_FILE_PARTS,
  registerMultipartCleanup,
  removeTempFiles,
  withTempFileCleanup,
  type BodyFactory,
  type TempFile,
} from "./multipart-cleanup";

/**
 * The multipart cleanup (v0.34, C1) against the INSTALLED parser: Strapi's
 * own body middleware (@strapi/core dist/middlewares/body.js → koa-body 6 →
 * formidable 2.1.5), extended by withTempFileCleanup, and Strapi's error
 * middleware, in a Koa app built like Strapi's (dist/services/server/koa.js),
 * fed raw multipart over a socket. Every case ends with the temp dir empty.
 * The registration runs against Strapi's own middleware registry.
 */

/** The parts of Koa's context the routes below use. */
interface Ctx {
  status: number;
  body: unknown;
  request: {
    files: Record<string, { filepath: string } | Array<{ filepath: string }>>;
    body: Record<string, unknown>;
  };
  forbidden(): void;
}
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;

const coreDir = () => strapiPackageDir("@strapi/core");
const { body } = requirePackageFile<{ body: BodyFactory }>(coreDir(), "dist/middlewares/body.js");
const { errors: errorMiddleware } = requirePackageFile<{ errors: () => Middleware }>(
  coreDir(),
  "dist/middlewares/errors.js",
);
const createKoaApp = requirePackageFile<
  (options: { proxy: boolean }) => { use(mw: Middleware): void; callback(): RequestListener }
>(coreDir(), "dist/services/server/koa.js");

const BOUNDARY = "sinnlos-c1-boundary";

const filePart = (name: string, filename: string, bytes: Buffer | string): Buffer =>
  Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    ),
    Buffer.from(bytes),
    Buffer.from("\r\n"),
  ]);

const fieldPart = (name: string, value: string): Buffer =>
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );

const multipart = (...parts: Buffer[]): Buffer =>
  Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`)]);

let uploadDir = "";
let server: Server | undefined;
const warn = vi.fn();

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
  uploadDir = "";
  warn.mockReset();
  vi.unstubAllGlobals();
});

/** Every file formidable opens: Strapi's body middleware with the opened files recorded. */
let opened: TempFile[] = [];
const recordingBody: BodyFactory = (config, deps) =>
  body(
    {
      ...config,
      formidable: {
        ...config?.formidable,
        onFileBegin: (name: string, file: TempFile) => {
          opened.push(file);
          (config?.formidable?.onFileBegin as (name: string, file: TempFile) => void)(name, file);
        },
      },
    },
    deps,
  );

/** Our middleware with Strapi's body middleware, then `downstream`; formidable writes to a fresh dir. */
async function serve(downstream: Middleware, maxFileSize = 1024): Promise<number> {
  opened = [];
  uploadDir = mkdtempSync(join(tmpdir(), "sinnlos-multipart-"));
  vi.stubGlobal("strapi", { log: { error: () => undefined } });
  const strapi = { plugin: () => undefined, log: { warn } };
  const app = createKoaApp({ proxy: false });
  app.use(errorMiddleware());
  app.use(
    withTempFileCleanup(recordingBody)({ formidable: { maxFileSize, uploadDir } }, { strapi }),
  );
  app.use(downstream);
  server = createServer(app.callback());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const leftovers = () => readdirSync(uploadDir);

function post(port: number, payload: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/upload",
        method: "POST",
        agent: false,
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          "content-length": payload.length,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ok: Middleware = async (ctx) => {
  ctx.status = 200;
  ctx.body = { ok: true };
};

describe("multipart-cleanup (C1)", () => {
  it("keeps the files readable for the route, then removes them before the answer", async () => {
    let seen = "";
    const port = await serve(async (ctx) => {
      seen = readFileSync((ctx.request.files.files as { filepath: string }).filepath, "utf8");
      ctx.status = 201;
    });
    const res = await post(port, multipart(filePart("files", "a.txt", "hello")));
    expect(res.status).toBe(201);
    expect(seen).toBe("hello");
    expect(leftovers()).toEqual([]);
  });

  it("removes a file under any other field name when the route refuses (the anonymous 403)", async () => {
    const port = await serve(async (ctx) => {
      expect(leftovers()).toHaveLength(1);
      ctx.forbidden();
    });
    const res = await post(port, multipart(filePart("orphan", "o.bin", "x".repeat(100))));
    expect(res.status).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("removes files a repeated `__proto__` name hides from ctx.request.files", async () => {
    const port = await serve(async (ctx) => {
      expect(leftovers()).toHaveLength(3);
      // The two `__proto__` files are not own keys of ctx.request.files.
      expect(Object.keys(ctx.request.files)).toEqual(["files"]);
      ctx.status = 200;
    });
    const res = await post(
      port,
      multipart(
        filePart("__proto__", "p1.bin", "one"),
        filePart("__proto__", "p2.bin", "two"),
        filePart("files", "f.bin", "three"),
      ),
    );
    expect(res.status).toBe(200);
    expect(leftovers()).toEqual([]);
  });

  it("removes every file of a mixed body (repeated names, other fields, text fields)", async () => {
    const port = await serve(async (ctx) => {
      expect(ctx.request.files.files).toHaveLength(2);
      expect(ctx.request.body.fileInfo).toBe("{}");
      expect(leftovers()).toHaveLength(4);
      ctx.status = 200;
    });
    const res = await post(
      port,
      multipart(
        filePart("files", "a.bin", "a"),
        fieldPart("fileInfo", "{}"),
        filePart("files", "b.bin", "b"),
        filePart("orphan", "c.bin", "c"),
        filePart("files[0]", "d.bin", "d"),
      ),
    );
    expect(res.status).toBe(200);
    expect(leftovers()).toEqual([]);
  });

  it("removes the files when the route throws", async () => {
    const port = await serve(async () => {
      expect(leftovers()).toHaveLength(1);
      throw new Error("boom");
    });
    const res = await post(port, multipart(filePart("files", "a.bin", "a")));
    expect(res.status).toBe(500);
    expect(leftovers()).toEqual([]);
  });

  it("refuses more than MAX_FILE_PARTS file parts with 413 before the route, opening no extra file", async () => {
    const route = vi.fn(ok);
    const port = await serve(route);
    const parts = Array.from({ length: MAX_FILE_PARTS + 5 }, (_, i) =>
      filePart(i % 2 ? "files" : "orphan", `${i}.bin`, `${i}`),
    );
    const res = await post(port, multipart(...parts));
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.name).toBe("PayloadTooLargeError");
    expect(route).not.toHaveBeenCalled();
    expect(opened).toHaveLength(MAX_FILE_PARTS);
    expect(leftovers()).toEqual([]);
  });

  it("closes and removes a file formidable opens after its own error cleanup (Codex lane r1 #1)", async () => {
    const route = vi.fn(ok);
    const port = await serve(route);
    // An empty base64 file fails formidable's minFileSize at its end; the
    // next part, in the same chunk, still gets a file that formidable
    // never ends or destroys.
    const payload = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="a.bin"\r\n` +
          "Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n\r\n",
      ),
      filePart("orphan", "b.bin", "unfinished"),
    ]);
    const started = Date.now();
    const res = await post(port, payload);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(route).not.toHaveBeenCalled();
    expect(opened.length).toBeGreaterThanOrEqual(2);
    for (const file of opened) expect(file._writeStream?.closed, file.filepath).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("keeps overlapping requests apart and removes the files of both", async () => {
    const seen: number[] = [];
    const port = await serve(async (ctx) => {
      const files = ctx.request.files.files;
      seen.push(Array.isArray(files) ? files.length : 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      ctx.status = 200;
    });
    const [one, two] = await Promise.all([
      post(port, multipart(filePart("files", "a.bin", "a"))),
      post(port, multipart(filePart("files", "b.bin", "b"), filePart("files", "c.bin", "c"))),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(seen.sort()).toEqual([1, 2]);
    expect(leftovers()).toEqual([]);
  });

  it("leaves Strapi's own unawaited removal nothing to do (no unhandled rejection, Codex lane r1 #3)", async () => {
    const fse = requireFromPackage<{ remove(path: string): Promise<void> }>(coreDir(), "fs-extra");
    const coreRemove = vi
      .spyOn(fse, "remove")
      .mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const port = await serve(ok);
      const res = await post(port, multipart(filePart("files", "a.bin", "a")));
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(coreRemove).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(leftovers()).toEqual([]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("still serves exactly MAX_FILE_PARTS file parts", async () => {
    const port = await serve(async (ctx) => {
      expect(leftovers()).toHaveLength(MAX_FILE_PARTS);
      ctx.status = 200;
    });
    const parts = Array.from({ length: MAX_FILE_PARTS }, (_, i) =>
      filePart("files", `${i}.bin`, "x"),
    );
    expect((await post(port, multipart(...parts))).status).toBe(200);
    expect(leftovers()).toEqual([]);
  });

  it("removes the partial file of an oversized upload (formidable's maxFileSize, 413)", async () => {
    const route = vi.fn(ok);
    const port = await serve(route, 1024);
    const res = await post(
      port,
      multipart(
        filePart("files", "ok.bin", "small"),
        filePart("orphan", "big.bin", "x".repeat(64 * 1024)),
      ),
    );
    expect(res.status).toBe(413);
    expect(route).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("removes the files of a malformed body (no closing boundary)", async () => {
    const route = vi.fn(ok);
    const port = await serve(route);
    const res = await post(port, filePart("orphan", "o.bin", "half a file"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(route).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("removes the partial file of an aborted upload", async () => {
    const route = vi.fn(ok);
    const port = await serve(route, 1024 * 1024);
    const head = filePart("orphan", "o.bin", "y".repeat(32 * 1024));
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api/upload",
      method: "POST",
      agent: false,
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        // Announces more than is ever sent.
        "content-length": head.length + 100_000,
      },
    });
    req.on("error", () => undefined);
    req.write(head);
    await until(() => leftovers().length === 1);
    req.destroy();
    await until(() => leftovers().length === 0);
    expect(route).not.toHaveBeenCalled();
  });

  it("leaves a JSON body to Strapi's parser as before", async () => {
    let parsed: unknown;
    const port = await serve(async (ctx) => {
      parsed = ctx.request.body;
      ctx.status = 200;
    });
    const payload = Buffer.from(JSON.stringify({ data: { title: "x" } }));
    const res = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/x",
          method: "POST",
          agent: false,
          headers: { "content-type": "application/json", "content-length": payload.length },
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    expect(res).toBe(200);
    expect(parsed).toEqual({ data: { title: "x" } });
  });
});

describe("removeTempFiles", () => {
  it("ignores a file that is already gone and logs a removal that fails", async () => {
    const log = { warn: vi.fn() };
    await removeTempFiles([{ filepath: join(tmpdir(), "sinnlos-c1-missing-file") }, {}], log);
    expect(log.warn).not.toHaveBeenCalled();
    // A directory cannot be removed without `recursive`: a logged failure, no throw.
    const dir = mkdtempSync(join(tmpdir(), "sinnlos-c1-dir-"));
    try {
      await removeTempFiles([{ filepath: dir }], log);
      expect(log.warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers after CLOSE_WAIT_MS but removes a slow stream's file only once it closes (Codex lane r1 #2)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = mkdtempSync(join(tmpdir(), "sinnlos-c1-slow-"));
    try {
      const filepath = join(dir, "slow");
      const stream = Object.assign(new EventEmitter(), { closed: false, destroy: vi.fn() });
      const log = { warn: vi.fn() };
      const done = removeTempFiles([{ filepath, _writeStream: stream }], log);
      expect(stream.destroy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CLOSE_WAIT_MS);
      await done;
      expect(log.warn).toHaveBeenCalledTimes(1);
      // The stream opens its file late, after the answer: removed on close.
      writeFileSync(filepath, "late");
      stream.closed = true;
      stream.emit("close");
      await vi.waitFor(() => expect(existsSync(filepath)).toBe(false), { interval: 10 });
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registerMultipartCleanup", () => {
  type Registry = {
    add(namespace: string, middlewares: Record<string, unknown>): void;
    get(uid: string): unknown;
    extend(uid: string, fn: (current: BodyFactory) => BodyFactory): unknown;
  };
  const registry = () => {
    const create = requirePackageFile<() => Registry>(coreDir(), "dist/registries/middlewares.js");
    const { middlewares } = requirePackageFile<{ middlewares: Record<string, unknown> }>(
      coreDir(),
      "dist/middlewares/index.js",
    );
    const reg = create();
    // What @strapi/core's loaders/middlewares.js does before register().
    reg.add("strapi::", middlewares);
    return reg;
  };

  it("replaces strapi::body in Strapi's registry with the extended factory, under the same name", async () => {
    const reg = registry();
    registerMultipartCleanup({ get: (name: string) => (name === "middlewares" ? reg : undefined) });
    const extended = reg.get("strapi::body") as BodyFactory;
    expect(extended).not.toBe(body);
    // The extended factory is the one Strapi resolves for the config entry:
    // it parses (Strapi's body) and cleans up (ours).
    uploadDir = mkdtempSync(join(tmpdir(), "sinnlos-multipart-"));
    vi.stubGlobal("strapi", { log: { error: () => undefined } });
    const app = createKoaApp({ proxy: false });
    app.use(errorMiddleware());
    const deps = { strapi: { plugin: () => undefined, log: { warn } } };
    app.use(extended({ formidable: { uploadDir } }, deps));
    app.use(async (ctx) => {
      expect(leftovers()).toHaveLength(1);
      ctx.forbidden();
    });
    server = createServer(app.callback());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const res = await post(
      (server.address() as AddressInfo).port,
      multipart(filePart("orphan", "o.bin", "x")),
    );
    expect(res.status).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("throws when the registry has no strapi::body (no boot without the cleanup)", () => {
    const create = requirePackageFile<() => Registry>(coreDir(), "dist/registries/middlewares.js");
    const empty = create();
    expect(() => registerMultipartCleanup({ get: () => empty })).toThrow(/strapi::body/);
  });
});
