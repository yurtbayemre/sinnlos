/**
 * Two responsibilities:
 * 1. On update, snapshot the PREVIOUS body into a wiki-revision so the
 *    revision log always points at a diff the user can restore.
 * 2. On any change, notify the Next.js frontend to invalidate cached
 *    page lookups — see apps/cms/src/utils/revalidate.ts.
 */
import { revalidate } from "../../../../utils/revalidate";

/**
 * Lifecycle data carries relations either as a plain id or — when the write
 * comes through the documents service / REST — as a link object like
 * `{ set: [{ id }] }` or `{ connect: [{ id }] }`. Normalize both to an id;
 * anything non-numeric means "unknown" (never feed it into a where clause).
 */
function relationId(raw: any): number | undefined {
  const entry =
    raw && typeof raw === "object"
      ? (raw.set?.[0] ?? raw.connect?.[0] ?? raw)
      : raw;
  const id = Number(entry && typeof entry === "object" ? entry.id : entry);
  return Number.isFinite(id) ? id : undefined;
}

async function tagsFor(event: any): Promise<string[]> {
  const result = event?.result;
  const pageSlug: string | undefined = result?.slug;
  const tags = ["wiki-pages"];

  // Relations aren't populated on lifecycle events — query the space by id
  // to resolve its slug for the specific per-space and per-page tags.
  const spaceId: number | undefined = relationId(
    result?.space?.id ?? event?.params?.data?.space,
  );
  if (spaceId) {
    const space = await strapi.db
      .query("api::wiki-space.wiki-space")
      .findOne({ where: { id: spaceId }, select: ["slug"] });
    if (space?.slug) {
      tags.push(`wiki-space:${space.slug}`);
      if (pageSlug) tags.push(`wiki-page:${space.slug}:${pageSlug}`);
    }
  }
  return tags;
}

export default {
  async beforeUpdate(event: any) {
    const { where, data } = event.params;
    if (!where?.id) return;
    if (!("body" in data)) return;

    const existing = await strapi.db.query("api::wiki-page.wiki-page").findOne({
      where: { id: where.id },
      populate: { lastEditor: true },
    });
    if (!existing?.body) return;
    if (existing.body === data.body) return;

    // The editor making the change is set by the controller via ctx.state.user.
    // We read it off data.lastEditor if present, otherwise fall back to existing.
    const editorId =
      (data as any).lastEditor?.id ||
      (data as any).lastEditor ||
      existing.lastEditor?.id;

    await strapi.db.query("api::wiki-revision.wiki-revision").create({
      data: {
        page: where.id,
        body: existing.body,
        summary: (data as any).revisionSummary ?? null,
        editor: editorId ?? null,
        publishedAt: new Date(),
      },
    });
  },

  async afterCreate(event: any) {
    await revalidate(await tagsFor(event));
  },
  async afterUpdate(event: any) {
    await revalidate(await tagsFor(event));
  },
  async afterDelete(event: any) {
    await revalidate(await tagsFor(event));
  },
};
