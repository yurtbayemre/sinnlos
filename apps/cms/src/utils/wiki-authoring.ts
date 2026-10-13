import {
  WIKI_REVISIONS_PAGE_SIZE,
  type WikiMyDraftRow,
  type WikiRevisionDetail,
  type WikiRevisionEntry,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import {
  AUTHORING_SPECS,
  answering,
  documentIdOf,
  documentStatus,
  gateFor,
  iso,
  noQuery,
  payloadOf,
  resultDto,
  revisionsOf,
  runDocumentMutation,
  withWikiEdit,
  type AuthoringContext,
  type AuthoringControllerHost,
  type AuthoringHandler,
} from "./authoring-controller";
import { WIKI_PAGE_UID } from "./authoring-uids";
import { etagOf, runInAuthoringScope, type AuthoringScope } from "./document-lock";
import { wikiGateExtrasOf } from "./wiki-gate";
import {
  getRevision,
  listRevisions,
  positiveId,
  restoreData,
  type RevisionListEntry,
  type WikiRevisionsHost,
} from "./wiki-revisions";
import { refuseKeys } from "./write-allowlist";

/**
 * The wiki-page draft and history actions (deep-dive decision 06 §J2, §J3;
 * batch 16 plan, lane 16B item 4; the HTTP contract is @sinnlos/domain
 * authoring/wiki.ts), next to the authoring controller's create, update,
 * publish, unpublish, discard-draft, delete, list and form read
 * (utils/authoring-controller.ts). api/wiki-page/controllers spreads both.
 * global::can-edit-wiki (utils/wiki-gate.ts) decides the class and the row
 * on every request; each action reads the decision and refuses a request
 * that reached it without one.
 *
 *   - createDraft: a new page as a draft only (the create rule of the
 *     caller's class); 201 with the result.
 *   - saveDraft: the draft only, never a publish (the update rule); a
 *     non-moderator thus drafts without ever lifting the status pin of the
 *     generic routes.
 *   - myDrafts: the caller's own pages with unpublished changes (never
 *     published, unpublished, or changes pending), newest first, in spaces
 *     the caller can read; the client query is ignored.
 *   - revisions, revision: the page's history (utils/wiki-revisions.ts,
 *     lane 16D), for its row classes and moderators only (question 9); a
 *     revision of another page answers 404.
 *   - restore: the draft update with the revision's content and the
 *     publish, in ONE transaction under ONE `If-Match` (the document lock
 *     checks a two-mutation request once), recorded with `restoredFrom`;
 *     publish readiness applies (a parent that is no longer published
 *     refuses with `notPublishable`).
 * Every write runs inside `wikiEditContext` with the caller as the editor.
 */

const SPEC = AUTHORING_SPECS[WIKI_PAGE_UID];

/** The slice of Strapi the actions use. */
export type WikiAuthoringHost = AuthoringControllerHost & WikiRevisionsHost;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A revision as the HTTP contract shows it (@sinnlos/domain WikiRevisionEntry). */
function entryOf(entry: RevisionListEntry): WikiRevisionEntry {
  return {
    id: entry.id,
    // Strapi stamps every row; an unreadable stamp reads as the epoch.
    createdAt: entry.createdAt ?? new Date(0).toISOString(),
    title: entry.title,
    changeSummary: entry.changeSummary,
    kind: entry.kind,
    editor: entry.editor,
    restoredFrom: entry.restoredFrom,
  };
}

/** The actions, spread into the wiki-page controller next to authoringActions. */
export function wikiPageActions(instance: unknown): Record<string, AuthoringHandler> {
  const strapi = instance as WikiAuthoringHost;
  const documents = () => strapi.documents(WIKI_PAGE_UID);

  const actions: Record<string, (ctx: AuthoringContext) => Promise<void>> = {
    async createDraft(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, WIKI_PAGE_UID, "createDraft");
        noQuery(ctx.query);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = {
          uid: WIKI_PAGE_UID,
          roleClass: gate.roleClass,
          source: "content-api",
        };
        const answer = await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            const created = await withWikiEdit(WIKI_PAGE_UID, gate, data, () =>
              documents().create({ data, status: "draft" }),
            );
            const documentId = documentIdOf(created);
            if (!documentId) throw new Error("wiki authoring: createDraft returned no document");
            return resultDto(strapi, SPEC, documentId, scope.committedRevision ?? 1);
          }),
        );
        ctx.set("ETag", etagOf(Number(answer.version)));
        ctx.status = 201;
        ctx.body = { data: answer };
      });
    },

    async saveDraft(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, WIKI_PAGE_UID, "saveDraft");
        noQuery(ctx.query);
        const data = payloadOf(ctx);
        await runDocumentMutation(strapi, SPEC, ctx, gate, 404, async (scope) => {
          await withWikiEdit(WIKI_PAGE_UID, gate, data, () =>
            documents().update({ documentId: scope.documentId, data, status: "draft" }),
          );
        });
      });
    },

    async myDrafts(ctx) {
      const gate = gateFor(ctx, WIKI_PAGE_UID, "myDrafts");
      // null: a moderator, who reads every space.
      const extras = wikiGateExtrasOf(gate);
      const visible = extras ? extras.visibleSpaceIds : new Set<number>();
      // Versions first, then the rows (authoring-controller.ts revisionsOf).
      const revisions = await revisionsOf(strapi, WIKI_PAGE_UID);
      const populate = {
        space: { select: ["id", "documentId", "slug", "name"] },
      };
      const select = ["id", "documentId", "title", "slug", "publishedAt", "updatedAt"];
      const drafts = (
        (await strapi.db.query(WIKI_PAGE_UID).findMany({
          where: { author: { id: gate.callerId }, publishedAt: { $null: true } },
          select,
          populate,
        })) as unknown[]
      ).filter(isRecord);
      const published = new Map<string, Record<string, unknown>>();
      const ids = drafts
        .map((row) => row.documentId)
        .filter((id): id is string => typeof id === "string");
      for (let i = 0; i < ids.length; i += 200) {
        const rows = (await strapi.db.query(WIKI_PAGE_UID).findMany({
          where: { documentId: { $in: ids.slice(i, i + 200) }, publishedAt: { $notNull: true } },
          select,
          populate,
        })) as unknown[];
        for (const row of rows.filter(isRecord)) {
          if (typeof row.documentId === "string") published.set(row.documentId, row);
        }
      }
      // A non-moderator lists only pages whose every row sits in a space
      // they read: the list must not name a hidden space.
      const readable = (row: Record<string, unknown> | undefined): boolean => {
        if (!row) return true;
        if (visible === null) return true;
        const space = isRecord(row.space) ? row.space : null;
        return space !== null && typeof space.id === "number" && visible.has(space.id);
      };
      const data: WikiMyDraftRow[] = [];
      for (const draft of drafts) {
        const documentId = draft.documentId as string;
        const twin = published.get(documentId);
        if (!readable(draft) || !readable(twin)) continue;
        const status = documentStatus(draft, twin ?? null);
        if (status === "published") continue;
        const space = isRecord(draft.space) ? draft.space : null;
        data.push({
          documentId,
          title: text(draft.title) ?? "",
          slug: text(draft.slug) ?? "",
          space:
            space && typeof space.documentId === "string"
              ? {
                  documentId: space.documentId,
                  slug: text(space.slug) ?? "",
                  name: text(space.name) ?? "",
                }
              : null,
          status,
          updatedAt: iso(draft.updatedAt),
          version: String(revisions.get(documentId) ?? 0),
        });
      }
      data.sort(
        (a, b) =>
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
          a.documentId.localeCompare(b.documentId),
      );
      ctx.status = 200;
      ctx.body = { data };
    },

    async revisions(ctx) {
      const gate = gateFor(ctx, WIKI_PAGE_UID, "revisions");
      const extra = Object.keys(ctx.query ?? {}).filter((key) => key !== "page");
      if (extra.length > 0) refuseKeys(extra);
      let page = 1;
      if (ctx.query?.page !== undefined) {
        const parsed =
          typeof ctx.query.page === "string" && /^\d{1,5}$/.test(ctx.query.page)
            ? Number(ctx.query.page)
            : NaN;
        if (!Number.isInteger(parsed) || parsed < 1) refuseKeys(["page"]);
        page = parsed;
      }
      const list = await listRevisions(strapi, gate.documentId as string, {
        page,
        pageSize: WIKI_REVISIONS_PAGE_SIZE,
      });
      ctx.status = 200;
      ctx.body = { data: list.results.map(entryOf), meta: { pagination: list.pagination } };
    },

    async revision(ctx) {
      const gate = gateFor(ctx, WIKI_PAGE_UID, "revision");
      noQuery(ctx.query);
      const revisionId = positiveId((ctx.params as Record<string, unknown>).revisionId);
      const revision =
        revisionId === null
          ? null
          : await getRevision(strapi, gate.documentId as string, revisionId);
      if (!revision) throw new errors.NotFoundError("Not Found");
      const detail: WikiRevisionDetail = {
        ...entryOf(revision),
        body: revision.body,
        pageSummary: revision.pageSummary,
      };
      ctx.status = 200;
      ctx.body = { data: detail };
    },

    async restore(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, WIKI_PAGE_UID, "restore");
        noQuery(ctx.query);
        const body = ctx.request.body;
        const keys = isRecord(body) ? Object.keys(body) : [];
        const extra = keys.filter((key) => key !== "revisionId");
        if (!isRecord(body) || extra.length > 0)
          refuseKeys(extra.length > 0 ? extra : ["revisionId"]);
        const revisionId = positiveId(body.revisionId);
        if (revisionId === null) refuseKeys(["revisionId"]);
        // Another page's revision is indistinguishable from a missing one.
        const revision = await getRevision(strapi, gate.documentId as string, revisionId);
        if (!revision) throw new errors.NotFoundError("Not Found");
        const data: Record<string, unknown> = {
          ...restoreData(revision),
          lastEditor: gate.callerId,
        };
        await runDocumentMutation(strapi, SPEC, ctx, gate, 404, async (scope) => {
          await withWikiEdit(
            WIKI_PAGE_UID,
            gate,
            null,
            async () => {
              await documents().update({ documentId: scope.documentId, data, status: "draft" });
              await documents().publish({ documentId: scope.documentId });
            },
            revision.id,
          );
        });
      });
    },
  };

  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      (ctx: unknown) => action(ctx as AuthoringContext),
    ]),
  );
}
