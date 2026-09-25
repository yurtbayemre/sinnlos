/**
 * On update, snapshot the PREVIOUS body into a wiki-revision so the
 * revision log always points at a diff the user can restore.
 */
import { wikiEditContext } from "../../../../utils/wiki-edit-context";

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

    // ctx.state.user never reaches db lifecycles — the REST controller
    // bridges the authenticated editor (and the optional revision summary,
    // which the core input validation would reject as an unknown key) via
    // wikiEditContext. data.lastEditor / existing.lastEditor remain as
    // fallbacks for writes that bypass the controller (admin panel, seeds).
    const editContext = wikiEditContext.getStore();
    const editorId =
      editContext?.editorId ??
      relationId((data as any).lastEditor ?? existing.lastEditor?.id);

    await strapi.db.query("api::wiki-revision.wiki-revision").create({
      data: {
        page: where.id,
        body: existing.body,
        summary: editContext?.revisionSummary ?? (data as any).revisionSummary ?? null,
        editor: editorId ?? null,
        publishedAt: new Date(),
      },
    });
  },
};
