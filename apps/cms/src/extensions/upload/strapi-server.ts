/**
 * Hardens the upload plugin's CONTENT-API endpoint (POST /api/upload),
 * which is the route employees hit when attaching photos to marketplace
 * ads. The admin panel's media library uses the separate admin routes and
 * is NOT affected by this wrapper.
 *
 * Enforced here (defense in depth on top of the users-permissions grant
 * `plugin::upload.content-api.upload`, which is only handed to
 * member/team_lead/department_head/editor/admin — never guest — and the
 * plugin-level `upload.security` config in config/plugins.ts):
 *
 *  1. Create-only: the core `upload` action doubles as replace/
 *     updateFileInfo when `?id=` is passed — with only the `upload`
 *     permission an employee could overwrite ANY existing media file
 *     (e.g. a company document's PDF). Rejected outright.
 *  2. Max 4 files per request (one marketplace ad's worth).
 *  3. Per-file size limit of 5 MB (the global plugin sizeLimit stays
 *     higher so admin document uploads keep working).
 *  4. Strict image allowlist — JPEG/PNG/WebP only, verified by MAGIC
 *     BYTES read from the temp file, not the client-declared mimetype.
 *     No SVG (stored-XSS vector, CVE-2022-32114 lineage) and no GIF
 *     (decompression-bomb surface) on purpose.
 *  5. Uploader attribution: after a successful upload the caller's user id
 *     is persisted as provider_metadata.uploadedBy on every created file.
 *     The classified controller only accepts image ids whose uploadedBy
 *     matches the caller (admin/editor bypass), so nobody can attach
 *     foreign media ids — avatars, documents, other people's photos — to
 *     their own ad. Pre-existing media has no uploadedBy and is therefore
 *     rejected there automatically.
 *
 * Strapi v5 plugin extension pattern (same as extensions/users-permissions):
 *   export default (plugin) => { ...mutate plugin...; return plugin; }
 * The upload plugin registers its controllers as factories, so we wrap the
 * factory and patch the returned controller object.
 */
import { open, stat } from "node:fs/promises";

const MAX_FILES_PER_REQUEST = 4;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Sniff the real content type from the file's first bytes. Returns the
 * canonical mime for the three allowed formats, or null for anything else.
 */
async function sniffAllowedImageMime(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buf, 0, 12, 0);
    if (bytesRead < 12) return null;
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
    // WebP: "RIFF" <size> "WEBP"
    if (
      buf.subarray(0, 4).toString("latin1") === "RIFF" &&
      buf.subarray(8, 12).toString("latin1") === "WEBP"
    ) {
      return "image/webp";
    }
    return null;
  } finally {
    await handle.close();
  }
}

export default (plugin: any) => {
  const originalControllerFactory = plugin.controllers["content-api"];

  plugin.controllers["content-api"] = (deps: any) => {
    const strapi = deps?.strapi;
    const controller =
      typeof originalControllerFactory === "function"
        ? originalControllerFactory(deps)
        : originalControllerFactory;
    const originalUpload = controller.upload;

    controller.upload = async function upload(ctx: any) {
      // 1. No replace / fileInfo update through the public API.
      if (ctx.query?.id !== undefined) {
        return ctx.forbidden("Replacing existing files is not allowed via this endpoint");
      }

      const filesInput = ctx.request?.files?.files;
      const files = Array.isArray(filesInput) ? filesInput : filesInput ? [filesInput] : [];
      if (files.length === 0) {
        return ctx.badRequest("No files provided");
      }
      // 2. Bounded batch size.
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
        // 3. Per-file size limit. A missing/non-numeric `size` is NEVER
        //    waved through: fall back to fs.stat on the temp file and
        //    reject when even that fails.
        let size: number = typeof file.size === "number" ? file.size : NaN;
        if (!Number.isFinite(size)) {
          try {
            size = (await stat(filePath)).size;
          } catch {
            return ctx.badRequest(`${name} could not be validated`);
          }
        }
        if (size > MAX_FILE_BYTES) {
          return ctx.badRequest(
            `${name} exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB limit`,
          );
        }
        // 4. Magic-byte allowlist.
        let sniffed: string | null = null;
        try {
          sniffed = await sniffAllowedImageMime(filePath);
        } catch {
          sniffed = null;
        }
        if (!sniffed) {
          return ctx.badRequest(`${name} is not an allowed image type (JPEG, PNG or WebP)`);
        }
        // Normalize the client-declared mimetype to the sniffed truth so the
        // stored file metadata can't lie about its content type.
        file.mimetype = sniffed;
      }

      const result = await originalUpload.call(this, ctx);

      // 5. Persist the uploader on every file this request created (the
      //    core controller puts the sanitized file list on ctx.body).
      //    provider_metadata is a plain json column the local provider
      //    leaves empty, so merging our key is safe; the classified
      //    controller matches it against the caller (see file header).
      const userId = ctx.state?.user?.id;
      const created = Array.isArray(ctx.body) ? ctx.body : ctx.body ? [ctx.body] : [];
      if (userId != null && strapi) {
        for (const uploaded of created) {
          const id = uploaded?.id;
          if (typeof id !== "number") continue;
          const row = await strapi.db
            .query("plugin::upload.file")
            .findOne({ where: { id } });
          if (!row) continue;
          await strapi.db.query("plugin::upload.file").update({
            where: { id },
            data: {
              provider_metadata: { ...(row.provider_metadata ?? {}), uploadedBy: userId },
            },
          });
        }
      }

      return result;
    };

    return controller;
  };

  return plugin;
};
