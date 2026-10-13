/**
 * The v2 authoring routes for the integration suites (batch 15 lane 15A;
 * the HTTP contract is @sinnlos/domain authoring/http.ts): one call per
 * intent, with `If-Match` taken from the last answer, as the web sends it.
 *
 *   const api = authoringApi(t);
 *   const created = await api.create("editor", "announcements", { title: "Hi" }, "draft");
 *   await api.publish("editor", "announcements", created.documentId, created.version);
 *
 * Named *.test.helper.ts like harness.test.helper.ts: not a suite, not part
 * of the cms build.
 */
import type { ApiResponse, Caller, TestStrapi } from "./harness.test.helper";

/** The `data` of a write answer (the DTO of @sinnlos/domain authoring/dto.ts). */
export interface AuthoringDto {
  documentId: string;
  version: string;
  status: "draft" | "published" | "modified";
  publishedAt: string | null;
  publishAt?: string | null;
  unpublishAt?: string | null;
  scheduleError?: string | null;
}

/** Strapi's error envelope. */
export interface ErrorBody {
  data: null;
  error: {
    status: number;
    name: string;
    message: string;
    details?: { keys?: string[]; codes?: Record<string, string>; current?: number };
  };
}

export type Answer<T = { data: AuthoringDto }> = ApiResponse<T & { error?: ErrorBody["error"] }>;

const ifMatch = (version: string | number | null | undefined): Record<string, string> =>
  version === null || version === undefined ? {} : { "If-Match": `"${version}"` };

export interface AuthoringApi {
  create(
    caller: Caller,
    plural: string,
    data: Record<string, unknown>,
    status?: string | null,
  ): Promise<Answer>;
  update(
    caller: Caller,
    plural: string,
    documentId: string,
    data: Record<string, unknown>,
    options?: { status?: string | null; version?: string | number | null; query?: string },
  ): Promise<Answer>;
  action(
    caller: Caller,
    plural: string,
    documentId: string,
    action: "publish" | "unpublish" | "discard-draft",
    version?: string | number | null,
  ): Promise<Answer>;
  remove(
    caller: Caller,
    plural: string,
    documentId: string,
    version?: string | number | null,
  ): Promise<Answer<Record<string, never>>>;
  editable<T = Record<string, unknown>>(
    caller: Caller,
    plural: string,
    documentId: string,
  ): Promise<Answer<{ data: T & { version: string } }>>;
  list<T = Record<string, unknown>>(
    caller: Caller,
    plural: string,
    query?: string,
  ): Promise<
    Answer<{ data: T[]; meta: { pagination: { page: number; total: number; pageCount: number } } }>
  >;
}

export function authoringApi(t: TestStrapi): AuthoringApi {
  return {
    create: (caller, plural, data, status = "published") =>
      t.api(caller, `/api/${plural}${status === null ? "" : `?status=${status}`}`, {
        json: { data },
      }),
    update: (caller, plural, documentId, data, options = {}) => {
      const status = options.status === undefined ? "draft" : options.status;
      const query = [status === null ? "" : `status=${status}`, options.query ?? ""]
        .filter(Boolean)
        .join("&");
      return t.api(caller, `/api/${plural}/${documentId}${query ? `?${query}` : ""}`, {
        method: "PUT",
        headers: ifMatch(options.version),
        json: { data },
      });
    },
    action: (caller, plural, documentId, action, version) =>
      t.api(caller, `/api/${plural}/${documentId}/${action}`, {
        method: "POST",
        headers: ifMatch(version),
      }),
    remove: (caller, plural, documentId, version) =>
      t.api(caller, `/api/${plural}/${documentId}`, {
        method: "DELETE",
        headers: ifMatch(version),
      }),
    editable: (caller, plural, documentId) =>
      t.api(caller, `/api/${plural}/${documentId}/editable`),
    list: (caller, plural, query = "") =>
      t.api(caller, `/api/${plural}/authoring${query ? `?${query}` : ""}`),
  };
}

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

/** Waits for the after-commit notification fan-outs of this cms (LF02). */
export function settleFanouts(t: TestStrapi): Promise<void> {
  return t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
}

/** The user ids notified about `documentId`, sorted (one row per notification). */
export async function notifiedUserIds(t: TestStrapi, documentId: string): Promise<number[]> {
  const rows = await t.strapi.db.query("api::notification.notification").findMany({
    where: { sourceDocumentId: documentId },
    populate: { recipient: { select: ["id"] } },
  });
  return rows
    .map((row) => (row.recipient as { id: number } | null)?.id ?? -1)
    .sort((a, b) => a - b);
}

/** The revision row of a document (content_versions), 0 without one. */
export async function storedRevision(t: TestStrapi, uid: string, documentId: string) {
  const row = await t.strapi.db.query("api::content-version.content-version").findOne({
    where: { targetUid: uid, targetDocumentId: documentId },
  });
  return row ? Number(row.revision) : 0;
}
