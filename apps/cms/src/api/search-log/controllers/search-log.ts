import { factories } from "@strapi/strapi";

import { sanitizeSearchLogInput } from "../../../utils/search-log-input";

const UID = "api::search-log.search-log";

export default factories.createCoreController(UID, ({ strapi }) => ({
  /**
   * Write-only, anonymous telemetry (issue #19). Server-authoritative
   * sanitization (pure helper, unit tested); the row is written via
   * strapi.db.query and the response is an empty 204 — no entity echo,
   * nothing to sanitize, no author stored BY DESIGN (privacy: the
   * analytics question is "does search work", not "who searched what").
   */
  async create(ctx) {
    if (!ctx.state.user) return ctx.unauthorized();

    const body = (ctx.request.body as any)?.data ?? ctx.request.body;
    const input = sanitizeSearchLogInput(body);
    if (!input) return ctx.badRequest("term required");

    await strapi.db.query(UID).create({ data: input });
    ctx.status = 204;
  },

  /**
   * Aggregated stats for /manage/analytics (admin-gated via route policy
   * + CUSTOM_ACTION_GRANTS). Grouping happens in SQL (knex) — the REST
   * layer has no GROUP BY, and shipping raw rows to the web just to
   * aggregate there would defeat the write-only posture.
   */
  async summary(ctx) {
    const days = Math.min(365, Math.max(1, Number(ctx.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const knex = strapi.db.connection;

    const base = () => knex("search_logs").where("created_at", ">=", since);

    const [totalRow, zeroRow, topTerms, topZeroTerms] = await Promise.all([
      base().count({ n: "*" }).first(),
      base().where("result_count", 0).count({ n: "*" }).first(),
      base()
        .select("term")
        .count({ n: "*" })
        .avg({ avgResults: "result_count" })
        .groupBy("term")
        .orderBy("n", "desc")
        .limit(10),
      base()
        .where("result_count", 0)
        .select("term")
        .count({ n: "*" })
        .groupBy("term")
        .orderBy("n", "desc")
        .limit(10),
    ]);

    ctx.send({
      windowDays: days,
      total: Number(totalRow?.n ?? 0),
      zeroResultCount: Number(zeroRow?.n ?? 0),
      topTerms: topTerms.map((r: any) => ({
        term: r.term,
        count: Number(r.n),
        avgResults: Math.round(Number(r.avgResults ?? 0) * 10) / 10,
      })),
      topZeroTerms: topZeroTerms.map((r: any) => ({ term: r.term, count: Number(r.n) })),
    });
  },
}));
