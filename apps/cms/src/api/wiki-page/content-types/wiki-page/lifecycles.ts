/**
 * Captures a wiki-revision snapshot each time a wiki-page is updated.
 *
 * We snapshot the PREVIOUS body before the update writes through so the
 * revision log always points at a diff the user can restore.
 */
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
};
