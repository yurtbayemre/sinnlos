/**
 * Hardens the upload plugin's CONTENT-API endpoint (POST /api/upload),
 * which is the route employees hit when attaching photos to marketplace
 * ads. The admin panel's media library uses the separate admin routes and
 * controllers (`admin-upload`, …) and is NOT affected by this wrapper.
 *
 * Enforced here (defense in depth on top of the users-permissions grant
 * `plugin::upload.content-api.upload`, which is only handed to
 * member/team_lead/department_head/editor/admin — never guest — and the
 * plugin-level `upload.security` config in config/plugins.ts). The pure
 * rules live in utils/upload-guard.ts (FX03):
 *
 *  1. Create-only: the core `upload` action doubles as replace/
 *     updateFileInfo when `?id=` is passed — with only the `upload`
 *     permission an employee could overwrite ANY existing media file
 *     (e.g. a company document's PDF). Rejected outright.
 *  2. Body allowlist (FX03): only the multipart field `fileInfo` is
 *     accepted. Core validateUploadBody keeps unknown keys and
 *     formatFileInfo turns ref/refId/field into a files_related_mph link on
 *     ANY entry (someone else's ad, an avatar, a document's file) —
 *     bypassing is-classified-author, the classified image ownership check,
 *     MAX_IMAGES and every write grant. `path` would steer the provider.
 *     Any other key → 400.
 *  3. Max 4 files per request (one marketplace ad's worth).
 *  4. Per-file size limit of 5 MB (the global plugin sizeLimit stays
 *     higher so admin document uploads keep working).
 *  5. Strict image allowlist — JPEG/PNG/WebP only, verified by MAGIC
 *     BYTES read from the temp file, not the client-declared mimetype.
 *     No SVG (stored-XSS vector, CVE-2022-32114 lineage) and no GIF
 *     (decompression-bomb surface) on purpose.
 *  6. Canonical filename (FX03): the client mimetype is overwritten with
 *     the sniffed type AND `originalFilename` becomes `<basename>.<canonical
 *     ext>`. Core stores/serves by extension when it disagrees with the
 *     content (mime-validation.js:221-224), so without this a JPEG-magic
 *     `x.pdf` / `x.css` was stored and served as application/pdf / text/css.
 *  7. Uploader attribution: the caller's user id is persisted as
 *     provider_metadata.uploadedBy on every file this request created.
 *     The classified controller only accepts image ids whose uploadedBy
 *     matches the caller (admin/editor bypass), so nobody can attach
 *     foreign media ids to their own ad; pre-existing media has no
 *     uploadedBy and is rejected there automatically. Stamping runs
 *     finally-style over the files ALREADY PERSISTED (FX03): core uploads
 *     sequentially without rollback, so on a partial multi-file failure the
 *     earlier files must still be stamped, or the janitor (which only ever
 *     touches stamped files) could never collect them. Persisted files are
 *     collected per request via the upload service's `media.create` event
 *     inside an AsyncLocalStorage scope, plus ctx.body on success.
 *
 * Upgrade tripwire (FX03): the wrapper relies on Strapi internals — the
 * `content-api` controller being a factory, and its single `upload` action
 * dispatching to uploadFiles/replaceFile/updateFileInfo via `this`
 * (upstream: "TODO: split into multiple endpoints"). Both are asserted and
 * a mismatch THROWS: at plugin load for the factory, at controller
 * instantiation (route composition, i.e. still during boot) for the
 * methods. A Strapi upgrade that changes either fails the boot instead of
 * silently un-hardening the endpoint.
 *
 * Strapi v5 plugin extension pattern: export default (plugin) => plugin.
 * The upload plugin registers its controllers as factories, so we wrap the
 * factory and patch the returned controller object — never assign methods
 * onto the factory itself (that is inert, see roadmap FX16).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { open, stat } from "node:fs/promises";

import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_BYTES,
  SNIFF_BYTES,
  canonicalFilename,
  createdFileIds,
  declaredSize,
  exceedsSizeLimit,
  isAllowedUploadBody,
  sniffImageMime,
  toFileArray,
} from "../../utils/upload-guard";

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
  state?: { user?: { id?: unknown } | null };
  body?: unknown;
  forbidden(message?: string): unknown;
  badRequest(message?: string): unknown;
}

type UploadAction = (this: unknown, ctx: UploadContext) => Promise<unknown>;
type ContentApiController = Record<string, unknown> & { upload: UploadAction };

/** The slice of the Strapi instance the wrapper uses. */
export interface UploadStrapi {
  db: {
    query(uid: string): {
      findOne(args: { where: { id: number } }): Promise<unknown>;
      update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>;
    };
  };
  eventHub: { on(event: string, listener: (payload?: unknown) => unknown): unknown };
  log: { error(message: string): void };
}

type ControllerFactory = (deps: { strapi: UploadStrapi }) => unknown;

export interface UploadPlugin {
  controllers: Record<string, unknown>;
}

/** File-system access, injectable for tests. */
export interface UploadIo {
  stat(filePath: string): Promise<{ size: unknown }>;
  /** Up to `bytes` bytes from the start of the file. */
  readHead(filePath: string, bytes: number): Promise<Uint8Array>;
}

const nodeIo: UploadIo = {
  stat: (filePath) => stat(filePath),
  async readHead(filePath, bytes) {
    const handle = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/** Ids of the file rows persisted inside the current wrapped upload call. */
const persistedInRequest = new AsyncLocalStorage<Set<number>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
 * user ids only — the janitor and cleanup-uploads trust nothing else
 * (utils/upload-orphans.ts uploadedByOf). Tries every id; throws the first
 * error afterwards so the caller decides whether to surface it.
 */
async function stampUploader(
  strapi: UploadStrapi,
  fileIds: Iterable<number>,
  userId: unknown,
): Promise<void> {
  if (typeof userId !== "number") return;
  const errors: unknown[] = [];
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
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

export function createUploadExtension(io: UploadIo = nodeIo) {
  return (plugin: UploadPlugin): UploadPlugin => {
    const originalControllerFactory = plugin?.controllers?.["content-api"];
    // Tripwire, plugin load: v5 registers the controller as a factory.
    if (typeof originalControllerFactory !== "function") {
      throw new Error(
        "[upload-extension] plugin.controllers['content-api'] is not a controller factory; " +
          "the POST /api/upload hardening cannot be applied (FX03 tripwire).",
      );
    }
    const factory = originalControllerFactory as ControllerFactory;

    plugin.controllers["content-api"] = (deps: { strapi: UploadStrapi }) => {
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
          return ctx.forbidden("Replacing existing files is not allowed via this endpoint");
        }
        // 2. Nothing but fileInfo in the body (no ref/refId/field/path).
        if (!isAllowedUploadBody(ctx.request?.body)) {
          return ctx.badRequest("Only files and fileInfo are accepted by this endpoint");
        }

        const files = toFileArray(ctx.request?.files?.files);
        if (files.length === 0) {
          return ctx.badRequest("No files provided");
        }
        // 3. Bounded batch size.
        if (files.length > MAX_FILES_PER_REQUEST) {
          return ctx.badRequest(`Too many files (max ${MAX_FILES_PER_REQUEST} per request)`);
        }

        for (const file of files) {
          const name = file.originalFilename ?? file.name ?? "file";
          // The temp path is needed for the size fallback AND the magic-byte
          // sniff (formidable writes multipart files to a temp path before
          // the controller runs) — a file we cannot inspect is rejected.
          const filePath = file.filepath ?? file.path;
          if (typeof filePath !== "string" || !filePath) {
            return ctx.badRequest(`${name} could not be validated`);
          }
          // 4. Per-file size limit. A missing/non-numeric `size` is NEVER
          //    waved through: fall back to fs.stat on the temp file and
          //    reject when even that fails or yields no number.
          let size = declaredSize(file.size);
          if (size === null) {
            try {
              size = declaredSize((await io.stat(filePath)).size);
            } catch {
              size = null;
            }
            if (size === null) return ctx.badRequest(`${name} could not be validated`);
          }
          if (exceedsSizeLimit(size)) {
            return ctx.badRequest(
              `${name} exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB limit`,
            );
          }
          // 5. Magic-byte allowlist.
          let sniffed: ReturnType<typeof sniffImageMime> = null;
          try {
            sniffed = sniffImageMime(await io.readHead(filePath, SNIFF_BYTES));
          } catch {
            sniffed = null;
          }
          if (!sniffed) {
            return ctx.badRequest(`${name} is not an allowed image type (JPEG, PNG or WebP)`);
          }
          // 6. Stored mime, stored extension and content must agree.
          file.mimetype = sniffed;
          file.originalFilename = canonicalFilename(name, sniffed);
        }

        // 7. Run the core upload inside a collection scope, then stamp every
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
        if (failure) throw failure.error;
        return result;
      };

      return controller;
    };

    return plugin;
  };
}

export default createUploadExtension();
