/**
 * Hardens the upload plugin's CONTENT-API endpoint (POST /api/upload) and
 * records every file delete. The admin panel's media library uses the
 * separate admin routes and controllers (`admin-upload`, …): its uploads are
 * NOT checked here (config/plugins.ts `deniedTypes` binds them), its deletes
 * are recorded (7 below).
 *
 * Enforced on POST /api/upload (defense in depth on top of the
 * users-permissions grant `plugin::upload.content-api.upload`, held by the
 * staff roles, never guest, and the plugin-level `upload.security` config).
 * The pure rules live in utils/upload-guard.ts (FX03; deep-dive decision 06
 * §E1 and owner amendment 2, batch 16 lane 16A):
 *
 *  1. Create-only: the core `upload` action doubles as replace/
 *     updateFileInfo when `?id=` is passed — with only the `upload`
 *     permission an employee could overwrite ANY existing media file
 *     (e.g. a company document's PDF). Refused outright: 403.
 *  2. Body allowlist (FX03): only the multipart field `fileInfo` is
 *     accepted. Core validateUploadBody keeps unknown keys and
 *     formatFileInfo turns ref/refId/field into a files_related_mph link on
 *     ANY entry (someone else's ad, an avatar, a document's file) —
 *     bypassing is-classified-author, the classified image ownership check,
 *     MAX_IMAGES and every write grant. `path` would steer the provider.
 *     `fileInfo` is checked against core's schema and its `name` dropped
 *     (core prefers it over the canonical file name); a malformed one
 *     answers 400 `fileInfo` instead of core's 500 on bad JSON.
 *  3. Two profiles by role (upload-guard.ts uploadProfileOf): moderators
 *     and department heads may upload PDF, DOCX, XLSX, PPTX (20 MB, exactly
 *     one such file per request) and images; everyone else images only
 *     (JPEG/PNG/WebP, 5 MB, up to 4 files: one ad's worth).
 *  4. The size is checked before any read (formidable's size, else
 *     fs.stat), against the profile's cap; then the content decides the
 *     format through one file handle (the head, a PDF's tail, a zip's
 *     directory, headers and `[Content_Types].xml`; never the whole file).
 *     No SVG (stored XSS), no GIF (decompression bombs), no macros.
 *  5. Canonical mime and name (FX03): the client mimetype is overwritten
 *     with the sniffed one and `originalFilename` becomes `<basename><ext>`
 *     of the table (@sinnlos/domain uploads.ts). Core stores and serves by
 *     extension when it disagrees with the content (mime-validation.js), so
 *     without this a JPEG-magic `x.pdf` was stored as application/pdf.
 *  6. Uploader attribution: the caller's user id is persisted as
 *     provider_metadata.uploadedBy on every file this request created
 *     (the classified controller and the media claims accept only the
 *     caller's own files; the janitor sweeps only stamped files). Stamping
 *     runs finally-style over the files ALREADY PERSISTED (FX03): core
 *     uploads sequentially without rollback, so on a partial multi-file
 *     failure the earlier files must still be stamped, or the janitor could
 *     never collect them. Persisted files are collected per request via the
 *     upload service's `media.create` event inside an AsyncLocalStorage
 *     scope, plus ctx.body on success.
 *
 * ERRORS (contract K14): every refusal is a 400 `ValidationError` with
 * `details.keys` and, for the file, `details.codes.file`: `fileType`,
 * `fileTooLarge`, `required` (no file) or `invalid` (too many files, an
 * uninspectable one, a name core refuses). The refusals core raises after
 * the wrapper are mapped the same way (a type refusal, a faulty image, its
 * size limit); everything else (storage, database) stays as core answers,
 * a 5xx for operational failures.
 *
 *  7. File deletes: the upload SERVICE's `remove` is wrapped so that every
 *     delete (Media Library single, bulk and folder deletes; claimAndRemove
 *     in utils/upload-orphans.ts) writes its audit row (utils/delete-audit.ts)
 *     in one transaction with core's delete of the bytes and the row: a
 *     failing audit insert removes nothing.
 *
 * Upgrade tripwire (FX03): the wrapper relies on Strapi internals — the
 * `content-api` controller and the `upload` service being factories, the
 * single `upload` action dispatching to uploadFiles/replaceFile/
 * updateFileInfo via `this` (upstream: "TODO: split into multiple
 * endpoints"), and the service's `remove(file)`. All are asserted and a
 * mismatch THROWS during boot instead of silently un-hardening the
 * endpoint or the trail.
 *
 * Strapi v5 plugin extension pattern: export default (plugin) => plugin.
 * The upload plugin registers controllers and services as factories, so we
 * wrap the factory and patch the returned object — never assign methods
 * onto the factory itself (that is inert, see roadmap FX16).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { open, stat } from "node:fs/promises";

import {
  UPLOAD_FILE_INFO_KEY,
  UPLOAD_FILE_KEY,
  UPLOAD_FORMAT_SPECS,
  type AuthoringFieldCode,
  type RoleHolder,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { recordDelete, type DeletedFile } from "../../utils/delete-audit";
import {
  MAX_FILES_PER_REQUEST,
  canonicalFilename,
  createdFileIds,
  declaredSize,
  normalizeFileInfo,
  profileMaxBytes,
  refusedBodyKeys,
  sniffUpload,
  toFileArray,
  uploadProfileOf,
} from "../../utils/upload-guard";
import { fileLinks } from "../../utils/upload-orphans";
import type { RandomAccessFile } from "../../utils/upload-zip";

const FILE_UID = "plugin::upload.file";
/** Upload service webhook event, emitted once per persisted file row. */
const MEDIA_CREATE_EVENT = "media.create";

/** Controller methods the wrapper calls or that `upload` dispatches to. */
export const REQUIRED_CONTROLLER_METHODS = [
  "upload",
  "uploadFiles",
  "replaceFile",
  "updateFileInfo",
] as const;

/** The formidable file fields the wrapper reads or rewrites. */
export interface IncomingUploadFile {
  originalFilename?: string | null;
  name?: string;
  filepath?: string;
  path?: string;
  size?: unknown;
  mimetype?: string;
}

/** The slice of the Koa context the wrapper uses. */
export interface UploadContext {
  query?: Record<string, unknown>;
  request?: {
    body?: unknown;
    files?: { files?: IncomingUploadFile | IncomingUploadFile[] } | null;
  };
  state?: { user?: ({ id?: unknown } & RoleHolder) | null };
  body?: unknown;
}

type UploadAction = (this: unknown, ctx: UploadContext) => Promise<unknown>;
type ContentApiController = Record<string, unknown> & { upload: UploadAction };

/** The slice of the Strapi instance the wrapper uses. */
export interface UploadStrapi {
  db: {
    query(uid: string): {
      findOne(args: { where: { id: number } }): Promise<unknown>;
      update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>;
      create?(args: { data: Record<string, unknown> }): Promise<unknown>;
    };
    transaction?<T>(callback: (scope: { trx: unknown }) => Promise<T>): Promise<T>;
  };
  eventHub: { on(event: string, listener: (payload?: unknown) => unknown): unknown };
  log: { error(message: string): void };
  requestContext?: { get(): unknown } | null;
}

type Factory = (deps: { strapi: UploadStrapi }) => unknown;

export interface UploadPlugin {
  controllers: Record<string, unknown>;
  services?: Record<string, unknown>;
}

/** An open temp file: positional reads through one handle. */
export interface OpenedUpload extends RandomAccessFile {
  close(): Promise<void>;
}

/** File-system access, injectable for tests. */
export interface UploadIo {
  stat(filePath: string): Promise<{ size: unknown }>;
  open(filePath: string): Promise<OpenedUpload>;
}

const nodeIo: UploadIo = {
  stat: (filePath) => stat(filePath),
  async open(filePath) {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      return {
        size,
        async read(position, length) {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buf, 0, length, position);
          return buf.subarray(0, bytesRead);
        },
        close: () => handle.close(),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  },
};

/** Ids of the file rows persisted inside the current wrapped upload call. */
const persistedInRequest = new AsyncLocalStorage<Set<number>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Refusals (K14).

const FILE_MESSAGES: Partial<Record<AuthoringFieldCode, string>> = {
  fileType: "This file type is not accepted",
  fileTooLarge: "This file is too large",
  required: "No file was uploaded",
  invalid: "This file cannot be accepted",
};

/** 400 for the file: `details.keys: ["file"]`, `details.codes.file`. */
export function fileRefusal(code: AuthoringFieldCode): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError(FILE_MESSAGES[code] ?? "Invalid file", {
    keys: [UPLOAD_FILE_KEY],
    codes: { [UPLOAD_FILE_KEY]: code },
  });
}

/** 400 for refused multipart fields (no code: "invalid"). */
function keysRefusal(keys: string[]): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError(`Invalid or disallowed data field(s): ${keys.join(", ")}`, {
    keys,
  });
}

/**
 * Core's own refusals after the wrapper, in the K14 shape; anything else
 * (storage, database, a bug) is returned unchanged.
 */
export function mapCoreUploadError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === "PayloadTooLargeError") return fileRefusal("fileTooLarge");
  if (error.name === "ValidationError") {
    const details = (error as { details?: unknown }).details;
    // validateUploadBody (yup) carries details.errors: the fileInfo schema.
    return isRecord(details) && Array.isArray(details.errors)
      ? keysRefusal([UPLOAD_FILE_INFO_KEY])
      : fileRefusal("fileType");
  }
  if (error.name === "ApplicationError") {
    if (error.message === "File is not a valid image") return fileRefusal("fileType");
    if (error.message === "File name contains invalid characters") return fileRefusal("invalid");
  }
  if (error instanceof SyntaxError) return keysRefusal([UPLOAD_FILE_INFO_KEY]);
  return error;
}

// ---------------------------------------------------------------------------
// The wrapper.

function assertControllerShape(controller: unknown): asserts controller is ContentApiController {
  const missing = isRecord(controller)
    ? REQUIRED_CONTROLLER_METHODS.filter((method) => typeof controller[method] !== "function")
    : [...REQUIRED_CONTROLLER_METHODS];
  if (missing.length > 0) {
    throw new Error(
      `[upload-extension] upload content-api controller no longer exposes ${missing.join(", ")}; ` +
        "the POST /api/upload hardening would be bypassed — review extensions/upload/strapi-server.ts " +
        "against this Strapi version before booting (FX03 tripwire).",
    );
  }
}

function assertStrapiShape(strapi: unknown): asserts strapi is UploadStrapi {
  const ok =
    isRecord(strapi) &&
    isRecord(strapi.db) &&
    typeof strapi.db.query === "function" &&
    isRecord(strapi.eventHub) &&
    typeof strapi.eventHub.on === "function";
  if (!ok) {
    throw new Error(
      "[upload-extension] controller factory did not receive { strapi } with db/eventHub (FX03 tripwire).",
    );
  }
}

/**
 * Merge `uploadedBy` into provider_metadata of every given file. Numeric
 * user ids only — the janitor and the claims trust nothing else
 * (utils/upload-orphans.ts uploadedByOf). Tries every id; throws the first
 * error afterwards so the caller decides whether to surface it.
 */
async function stampUploader(
  strapi: UploadStrapi,
  fileIds: Iterable<number>,
  userId: unknown,
): Promise<void> {
  if (typeof userId !== "number") return;
  const failures: unknown[] = [];
  for (const id of fileIds) {
    try {
      const row = await strapi.db.query(FILE_UID).findOne({ where: { id } });
      if (!isRecord(row)) continue;
      const metadata = isRecord(row.provider_metadata) ? row.provider_metadata : {};
      await strapi.db.query(FILE_UID).update({
        where: { id },
        data: { provider_metadata: { ...metadata, uploadedBy: userId } },
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/** Checks one file and canonicalises it, or throws its refusal. */
async function checkFile(
  io: UploadIo,
  file: IncomingUploadFile,
  profile: ReturnType<typeof uploadProfileOf>,
): Promise<{ document: boolean }> {
  const name = file.originalFilename ?? file.name ?? "file";
  // formidable writes multipart files to a temp path before the controller
  // runs; a file we cannot inspect is refused.
  const filePath = file.filepath ?? file.path;
  if (typeof filePath !== "string" || !filePath) throw fileRefusal("invalid");
  // The size before any read. A missing/non-numeric `size` is NEVER waved
  // through: fs.stat on the temp file, refused when even that fails.
  let size = declaredSize(file.size);
  if (size === null) {
    try {
      size = declaredSize((await io.stat(filePath)).size);
    } catch {
      size = null;
    }
    if (size === null) throw fileRefusal("invalid");
  }
  if (size > profileMaxBytes(profile)) throw fileRefusal("fileTooLarge");
  let opened: OpenedUpload;
  try {
    opened = await io.open(filePath);
  } catch {
    throw fileRefusal("invalid");
  }
  let result: Awaited<ReturnType<typeof sniffUpload>>;
  try {
    result = await sniffUpload(opened, profile);
  } finally {
    await opened.close().catch(() => undefined);
  }
  if (result.ok === false) throw fileRefusal(result.code);
  const spec = UPLOAD_FORMAT_SPECS[result.format];
  file.mimetype = spec.mime;
  file.originalFilename = canonicalFilename(name, result.format);
  return { document: spec.kind === "document" };
}

/**
 * Runs the upload service's `remove(file)` with its audit row, in one
 * transaction (7 in the header): the row commits exactly when the file
 * row's delete commits; a failing insert removes nothing.
 */
async function removeWithDeleteAudit<T>(
  strapi: UploadStrapi,
  file: DeletedFile,
  remove: () => Promise<T>,
): Promise<T> {
  const transaction = strapi.db.transaction;
  if (typeof transaction !== "function") {
    throw new Error("[upload-extension] strapi.db.transaction is missing (delete-audit tripwire)");
  }
  return transaction.call(strapi.db, async ({ trx }) => {
    const links = typeof file.id === "number" ? await fileLinks(strapi, file.id, trx) : [];
    await recordDelete(strapi as never, { kind: "file", file, links });
    return remove();
  });
}

/**
 * Marks the factories this extension installed. @strapi/upload exports its
 * controllers and services as module-level objects, so a second Strapi in
 * the same process (the integration harness boots one per engine) hands
 * the extension the already wrapped factories: wrapping them again would
 * run every check, and every delete's audit row, twice.
 */
const WRAPPED = Symbol.for("sinnlos.upload-extension.wrapped");

const isWrapped = (factory: unknown): boolean =>
  typeof factory === "function" &&
  (factory as unknown as Record<symbol, unknown>)[WRAPPED] === true;

function markWrapped<T extends object>(factory: T): T {
  Object.defineProperty(factory, WRAPPED, { value: true });
  return factory;
}

export function createUploadExtension(io: UploadIo = nodeIo) {
  return (plugin: UploadPlugin): UploadPlugin => {
    if (isWrapped(plugin?.controllers?.["content-api"]) && isWrapped(plugin?.services?.upload)) {
      return plugin;
    }
    const originalControllerFactory = plugin?.controllers?.["content-api"];
    // Tripwire, plugin load: v5 registers the controller as a factory.
    if (typeof originalControllerFactory !== "function") {
      throw new Error(
        "[upload-extension] plugin.controllers['content-api'] is not a controller factory; " +
          "the POST /api/upload hardening cannot be applied (FX03 tripwire).",
      );
    }
    const originalServiceFactory = plugin?.services?.upload;
    if (typeof originalServiceFactory !== "function") {
      throw new Error(
        "[upload-extension] plugin.services.upload is not a service factory; " +
          "file deletes would go unrecorded (delete-audit tripwire).",
      );
    }
    const factory = originalControllerFactory as Factory;
    const serviceFactory = originalServiceFactory as Factory;

    (plugin.services as Record<string, unknown>).upload = markWrapped(
      (deps: { strapi: UploadStrapi }) => {
        const service = serviceFactory(deps) as Record<string, unknown>;
        const originalRemove = service?.remove;
        if (typeof originalRemove !== "function") {
          throw new Error(
            "[upload-extension] the upload service no longer exposes remove(file) (delete-audit tripwire).",
          );
        }
        service.remove = (file: DeletedFile) =>
          removeWithDeleteAudit(deps.strapi, file, () => originalRemove.call(service, file));
        return service;
      },
    );

    plugin.controllers["content-api"] = markWrapped((deps: { strapi: UploadStrapi }) => {
      const strapi = deps?.strapi;
      assertStrapiShape(strapi);
      const controller = factory(deps);
      // Tripwire, controller instantiation (route composition at boot).
      assertControllerShape(controller);

      // Collect every file row the upload service persists while one of
      // OUR wrapped calls is on the async stack; admin uploads run outside
      // the scope and are ignored.
      strapi.eventHub.on(MEDIA_CREATE_EVENT, (payload?: unknown) => {
        const ids = persistedInRequest.getStore();
        const media = isRecord(payload) ? payload.media : undefined;
        const id = isRecord(media) ? media.id : undefined;
        if (ids && typeof id === "number") ids.add(id);
      });

      const originalUpload = controller.upload;

      controller.upload = async function upload(this: unknown, ctx: UploadContext) {
        // 1. No replace / fileInfo update through the public API.
        if (ctx.query?.id !== undefined) {
          throw new errors.ForbiddenError(
            "Replacing existing files is not allowed via this endpoint",
          );
        }
        // 2. Nothing but fileInfo in the body (no ref/refId/field/path).
        const refused = refusedBodyKeys(ctx.request?.body);
        if (refused.length > 0) throw keysRefusal(refused);

        const files = toFileArray(ctx.request?.files?.files);
        if (files.length === 0) throw fileRefusal("required");
        if (files.length > MAX_FILES_PER_REQUEST) throw fileRefusal("invalid");

        const fileInfo = normalizeFileInfo(
          isRecord(ctx.request?.body) ? ctx.request.body.fileInfo : undefined,
          files.length,
        );
        if (fileInfo.malformed === true) throw keysRefusal([UPLOAD_FILE_INFO_KEY]);

        // 3.-5. Profile, size, content, canonical mime and name.
        const profile = uploadProfileOf(ctx.state?.user);
        let documents = 0;
        for (const file of files) {
          if ((await checkFile(io, file, profile)).document) documents += 1;
        }
        // A PDF or Office file travels alone (the web takes the sole result).
        if (documents > 0 && files.length > 1) throw fileRefusal("invalid");
        if (ctx.request) {
          ctx.request.body = fileInfo.value === undefined ? {} : { fileInfo: fileInfo.value };
        }

        // 6. Run the core upload inside a collection scope, then stamp every
        //    persisted file — also when the core failed half-way.
        const persisted = new Set<number>();
        let failure: { error: unknown } | null = null;
        let result: unknown;
        try {
          result = await persistedInRequest.run(persisted, () => originalUpload.call(this, ctx));
        } catch (error) {
          failure = { error };
        }
        // The core controller puts the sanitized created files on ctx.body.
        if (!failure) for (const id of createdFileIds(ctx.body)) persisted.add(id);

        try {
          await stampUploader(strapi, persisted, ctx.state?.user?.id);
        } catch (stampError) {
          const reason = stampError instanceof Error ? stampError.message : String(stampError);
          strapi.log.error(
            `[upload-extension] could not stamp uploadedBy on file(s) ${[...persisted].join(", ")}: ${reason}`,
          );
          // Never mask the core's own error; on success an unstamped file
          // must not be reported as usable (the ad create would reject it).
          if (!failure) throw stampError;
        }
        if (failure) throw mapCoreUploadError(failure.error);
        return result;
      };

      return controller;
    });

    return plugin;
  };
}

export default createUploadExtension();
