import { factories } from "@strapi/strapi";

import { attachedFileIds, removeUploadFile, uploadedByOf } from "../../../utils/upload-orphans";

/**
 * Classifieds are user-generated content created from the web app (not the
 * admin panel), so every write path is sanitized server-side:
 *
 *  - `author` is ALWAYS taken from ctx.state.user (kudos/comment pattern) —
 *    the payload can never impersonate another user.
 *  - `expiresAt` is clamped to [today, today + 90 days]; a missing/invalid
 *    value defaults to today + 30 days (auto-expire keeps the board clean
 *    without a cron: the web list simply filters expiresAt >= today).
 *  - `images` is limited to 4 ids that must exist in the media library and
 *    actually be images (the upload route itself is hardened separately in
 *    src/extensions/upload/strapi-server.ts).
 *  - Only whitelisted attributes are forwarded to the core controller; any
 *    other payload key is dropped.
 *
 * draftAndPublish is OFF (immediate visibility, poll-vote/acknowledgement
 * precedent), so numeric ids are stable and nothing here needs the
 * targetDocumentId anchoring used by acknowledgements.
 */

const MAX_IMAGES = 4;
const DEFAULT_LIFETIME_DAYS = 30;
const MAX_LIFETIME_DAYS = 90;

/** Format a Date as local YYYY-MM-DD (toISOString would shift across UTC). */
function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Calendar-safe day addition (no *86400000 math — DST-proof). */
function addDays(base: Date, days: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

/**
 * Clamp a requested expiry date into [today, today + MAX_LIFETIME_DAYS].
 * Missing/invalid input falls back to today + DEFAULT_LIFETIME_DAYS.
 * "today" is a valid floor on purpose: an ad expiring today is still shown
 * for the rest of the day (web filter is expiresAt >= today).
 */
function clampExpiresAt(value: unknown): string {
  const today = new Date();
  const min = addDays(today, 0);
  const max = addDays(today, MAX_LIFETIME_DAYS);

  let candidate: Date | null = null;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) candidate = parsed;
  }
  if (!candidate) candidate = addDays(today, DEFAULT_LIFETIME_DAYS);
  if (candidate.getTime() > max.getTime()) candidate = max;
  if (candidate.getTime() < min.getTime()) candidate = min;
  return localDateString(candidate);
}

/**
 * Normalize + verify the images payload. Returns the deduplicated id list
 * or null when the payload is invalid (wrong shape, > MAX_IMAGES, unknown
 * file id, a file that is not an image, or a file the caller did not
 * upload themselves).
 *
 * Ownership: the upload extension stamps provider_metadata.uploadedBy on
 * every content-api upload, and only files stamped with the CALLER's id
 * are accepted here (admin_role/editor bypass for moderation edits).
 * Media without uploadedBy — avatars, documents, anything predating the
 * marketplace — is rejected automatically, so foreign media ids can never
 * be attached to an ad.
 */
async function resolveImageIds(value: unknown, strapi: any, user: any): Promise<number[] | null> {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;

  const ids: number[] = [];
  for (const entry of value) {
    const id =
      typeof entry === "object" && entry !== null ? Number((entry as any).id) : Number(entry);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return [];
  if (ids.length > MAX_IMAGES) return null;

  const files = await strapi.db
    .query("plugin::upload.file")
    .findMany({ where: { id: { $in: ids } } });
  if (files.length !== ids.length) return null;
  if (!files.every((f: any) => typeof f.mime === "string" && f.mime.startsWith("image/"))) {
    return null;
  }
  const isModerator = user?.role?.type === "admin_role" || user?.role?.type === "editor";
  if (!isModerator) {
    const ownsAll =
      user != null &&
      files.every((f: any) => (f.provider_metadata as any)?.uploadedBy === user.id);
    if (!ownsAll) return null;
  }
  return ids;
}

/** Parse and validate the optional price payload. NaN/negative → error. */
function resolvePrice(value: unknown): { ok: true; price: number | null } | { ok: false } {
  if (value == null || value === "") return { ok: true, price: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false };
  return { ok: true, price: Math.round(parsed * 100) / 100 };
}

export default factories.createCoreController("api::classified.classified", ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as any;
    const input = (body.data ?? body) as Record<string, unknown>;

    const priceResult = resolvePrice(input.price);
    if (!priceResult.ok) return ctx.badRequest("Invalid price");

    const images = await resolveImageIds(input.images, strapi, user);
    if (images === null) {
      return ctx.badRequest(`Invalid images (max ${MAX_IMAGES} own image files)`);
    }

    const category = input.category;
    ctx.request.body = {
      data: {
        title: typeof input.title === "string" ? input.title.trim() : input.title,
        description:
          typeof input.description === "string" ? input.description.trim() : input.description,
        category,
        // A giveaway has no price by definition — normalize instead of 400ing.
        price: category === "giveaway" ? null : priceResult.price,
        priceNegotiable: category === "giveaway" ? false : input.priceNegotiable === true,
        location: typeof input.location === "string" ? input.location.trim() : null,
        images,
        expiresAt: clampExpiresAt(input.expiresAt),
        // Server-authoritative — never from the payload.
        author: user.id,
      },
    };
    return super.create(ctx);
  },

  async update(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    // The is-classified-author policy has already verified ownership (or
    // admin/editor moderation bypass). Resolve the entity here anyway: the
    // web app addresses ads by numeric id, but the v5 core controller
    // resolves by documentId — an untranslated numeric id would 404
    // (comment controller gotcha).
    const idParam = String(ctx.params.id);
    const entity = await strapi.db.query("api::classified.classified").findOne({
      where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    });
    if (!entity) return ctx.notFound();

    const body = (ctx.request.body ?? {}) as any;
    const input = (body.data ?? body) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    if ("title" in input) {
      data.title = typeof input.title === "string" ? input.title.trim() : input.title;
    }
    if ("description" in input) {
      data.description =
        typeof input.description === "string" ? input.description.trim() : input.description;
    }
    if ("category" in input) data.category = input.category;
    if ("price" in input) {
      const priceResult = resolvePrice(input.price);
      if (!priceResult.ok) return ctx.badRequest("Invalid price");
      data.price = priceResult.price;
    }
    if ("priceNegotiable" in input) data.priceNegotiable = input.priceNegotiable === true;
    if ("location" in input) {
      data.location = typeof input.location === "string" ? input.location.trim() : null;
    }
    if ("images" in input) {
      const images = await resolveImageIds(input.images, strapi, user);
      if (images === null) {
        return ctx.badRequest(`Invalid images (max ${MAX_IMAGES} own image files)`);
      }
      data.images = images;
    }
    // Renewing an ad is a plain update with a fresh expiresAt — clamped the
    // same way as on create, so nobody can push an ad past +90 days.
    if ("expiresAt" in input) data.expiresAt = clampExpiresAt(input.expiresAt);

    const effectiveCategory = ("category" in data ? data.category : entity.category) as string;
    if (effectiveCategory === "giveaway") {
      data.price = null;
      data.priceNegotiable = false;
    }

    // `author` is deliberately never copied — ownership is immutable.
    ctx.params.id = entity.documentId;
    ctx.request.body = { data };
    return super.update(ctx);
  },

  async delete(ctx) {
    // Same numeric-id → documentId translation as update; the v5 core
    // delete would otherwise answer 204 while deleting nothing.
    const idParam = String(ctx.params.id);
    const entity = await strapi.db.query("api::classified.classified").findOne({
      where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    });
    if (!entity) return ctx.notFound();
    ctx.params.id = entity.documentId;
    return super.delete(ctx);
  },

  /**
   * POST /api/classifieds/cleanup-uploads — best-effort orphan removal for
   * the two-step web flow (issue #13): when step 2 (create/update) fails
   * after step 1 (upload) succeeded, or when an update deselects images,
   * the web action posts the ids here instead of leaving them for the
   * nightly janitor.
   *
   * Strictly self-service, no moderator bypass: a file is only removed
   * when it (a) exists, (b) is stamped with the CALLER's id in
   * provider_metadata.uploadedBy (the marketplace-upload stamp — admin
   * uploads like avatars/documents carry none and can never match), and
   * (c) has no relation left in files_related_mph (the same image may hang
   * on another of the caller's ads). Anything else is silently skipped —
   * the endpoint is idempotent and safe to call with stale ids.
   */
  async cleanupUploads(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as any;
    const raw = (body.data ?? body)?.imageIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMAGES) {
      return ctx.badRequest(`imageIds must be 1-${MAX_IMAGES} file ids`);
    }
    const ids: number[] = [];
    for (const entry of raw) {
      const id = Number(entry);
      if (!Number.isInteger(id) || id <= 0) return ctx.badRequest("Invalid file id");
      if (!ids.includes(id)) ids.push(id);
    }

    const files = await strapi.db
      .query("plugin::upload.file")
      .findMany({ where: { id: { $in: ids } } });
    const stillAttached = await attachedFileIds(strapi, ids);

    let removed = 0;
    for (const file of files) {
      if (uploadedByOf(file) !== user.id) continue;
      if (stillAttached.has(file.id)) continue;
      if (await removeUploadFile(strapi, file)) removed += 1;
    }
    ctx.body = { removed };
  },
}));
