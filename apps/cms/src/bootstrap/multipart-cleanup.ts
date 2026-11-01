/**
 * Every multipart temp file is removed when its request ends (v0.34, C1).
 * register() (src/index.ts) extends Strapi's own `strapi::body` factory in
 * the middleware registry (`strapi.get("middlewares").extend`, @strapi/core
 * 5.60 registries/middlewares.js): `strapi::body` stays in
 * config/middlewares.ts, because Strapi refuses to start without it
 * (services/server/register-middlewares.js requiredMiddlewares). The
 * extension calls the original factory (dist/middlewares/body.js) once per
 * request, with formidable options that close over that request.
 *
 * Why. formidable (2.1.5 through koa-body 6) writes every file part to the
 * temp dir while it parses, before any route, policy or authentication
 * runs. Strapi then removes only the field `files`, unawaited, and not at
 * all when the route throws: an anonymous POST to any /api/* route with a
 * file under another field name got its 403 and left up to 50 MB on the
 * container layer (= the host disk), per request (audit 2026-10-31, C1,
 * live-confirmed). Walking `ctx.request.files` afterwards is not enough
 * either: a part named `__proto__` becomes the prototype of that object and
 * a repeated name keeps only the last file (formidable's `files[name] =
 * file`, Codex plan review r1 #3).
 *
 * How.
 *   - `onFileBegin` records every file object as formidable creates it
 *     (before `file.open()`), whatever its field name;
 *   - `filter` counts the file parts and lets at most MAX_FILE_PARTS of them
 *     become files; past that the parse goes on (the bytes are dropped, no
 *     file is opened) and the request answers 413 before any route runs.
 *     Refusing in `fileBegin` would come too late: formidable opens the
 *     file right after that event, whatever a listener did;
 *   - `finally`, around the parse AND the rest of the request: destroy
 *     each file's write stream that is still open (after a parse error
 *     formidable can still open a later part's file, which it never ends
 *     or destroys), wait until it is closed (an fs stream may still be
 *     opening its file), then remove the file, awaited, ignoring a file
 *     that is already gone. Aborted, malformed and oversized bodies end up
 *     here too. A stream that does not close within CLOSE_WAIT_MS no
 *     longer holds the answer: its file is removed once it closes;
 *   - Strapi's own removal of the `files` field after the route (unawaited,
 *     its failure an unhandled rejection) is left nothing to do: the
 *     request's `files` are dropped from ctx once the route is done.
 *
 * Residual (edge request-size limits were cut, v0.34 plan rev2): until a
 * request ends, its files stay on disk, up to the 50 MB formidable limit
 * per request; concurrent requests add up.
 */
import { rm } from "node:fs/promises";
import { errors } from "@strapi/utils";

/**
 * File parts one request may carry. The web sends at most
 * CLASSIFIED_MAX_IMAGES (4) per upload, the admin panel one file per
 * request (@strapi/upload 5.60 admin `uploadFiles`); the upload extension
 * refuses more than 4 on POST /api/upload anyway (MAX_FILES_PER_REQUEST).
 */
export const MAX_FILE_PARTS = 20;

/** How long the answer waits for a write stream to close (the removal still follows the close). */
export const CLOSE_WAIT_MS = 10_000;

/** What the cleanup reads of a formidable 2.x PersistentFile. */
export interface TempFile {
  filepath?: string;
  /** Created by `file.open()` (formidable 2.x, not part of its public API). */
  _writeStream?: {
    closed?: boolean;
    destroy(): void;
    once(event: "close", listener: () => void): unknown;
  };
}

/** Koa's context; only the parsed files are read (and dropped). */
type Ctx = { request?: { files?: unknown } };
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;
/** strapi::body's config (config/middlewares.ts); only `formidable` is read here. */
export type BodyConfig =
  { formidable?: Record<string, unknown>; [key: string]: unknown } | undefined;
type Deps = { strapi: { log: { warn(message: string): void } } };
export type BodyFactory = (config: BodyConfig, deps: Deps) => Middleware;

/** The slice of Strapi's middleware registry (registries/middlewares.js) this uses. */
export interface MiddlewareRegistryHost {
  get(name: "middlewares"): {
    extend(uid: string, extendFn: (current: BodyFactory) => BodyFactory): unknown;
  };
}

type Log = { warn(message: string): void };

async function remove(file: TempFile, log: Log): Promise<void> {
  if (!file.filepath) return;
  try {
    await rm(file.filepath, { force: true });
  } catch (error) {
    log.warn(`[multipart-cleanup] could not remove a temp file: ${(error as Error).message}`);
  }
}

/**
 * Destroys each file's stream that is still open, waits for it to close and
 * removes the file (exported for the tests). A stream that takes longer
 * than CLOSE_WAIT_MS is removed once it closes, without holding the answer.
 */
export async function removeTempFiles(files: readonly TempFile[], log: Log): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const stream = file._writeStream;
      if (stream && !stream.closed) {
        const closed = new Promise<void>((resolve) => stream.once("close", resolve));
        stream.destroy();
        let timer: NodeJS.Timeout | undefined;
        const late = await Promise.race([
          closed.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), CLOSE_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (late) {
          log.warn("[multipart-cleanup] a temp file did not close in time; removed once it does");
          void closed.then(() => remove(file, log));
          return;
        }
      }
      await remove(file, log);
    }),
  );
}

/** `strapi::body` (the original factory) with the temp-file bookkeeping around it. */
export function withTempFileCleanup(original: BodyFactory): BodyFactory {
  return (config, deps) => async (ctx, next) => {
    const files: TempFile[] = [];
    let fileParts = 0;
    const body = original(
      {
        ...config,
        formidable: {
          ...config?.formidable,
          filter: () => {
            fileParts += 1;
            return fileParts <= MAX_FILE_PARTS;
          },
          onFileBegin: (_name: string, file: TempFile) => {
            files.push(file);
          },
        },
      },
      deps,
    );
    try {
      await body(ctx, async () => {
        if (fileParts > MAX_FILE_PARTS) {
          throw new errors.PayloadTooLargeError(`At most ${MAX_FILE_PARTS} files per request`);
        }
        try {
          await next();
        } finally {
          // The removal below owns these files: Strapi's own (body.js, after
          // the route) is unawaited and would race it.
          if (ctx.request) delete ctx.request.files;
        }
      });
    } finally {
      await removeTempFiles(files, deps.strapi.log);
    }
  };
}

/** Called in register(); throws (no boot) when Strapi has no `strapi::body` to extend. */
export function registerMultipartCleanup(strapi: MiddlewareRegistryHost): void {
  strapi.get("middlewares").extend("strapi::body", withTempFileCleanup);
}
