import { errors } from "@strapi/utils";

import { LESSON_UID, WIKI_PAGE_UID, isScheduledUid } from "./authoring-uids";

/**
 * Publish readiness (decision 06 §D rule 3 and §G2 "publish readiness";
 * batch 15 plan, contract K3): can this draft be published as it stands?
 *
 * `publishBlockers(strapi, uid, mergedDraft)` answers the attribute keys
 * that block, [] when none does:
 *   - the checks Strapi's PUBLISHED validation adds to the draft one
 *     (@strapi/core entity-validator: drafts are validated with `isDraft`,
 *     C24): a `required` scalar that is null or missing, an integer or
 *     number below its `min`, a string shorter than its `minLength`;
 *   - the relation targets a publish would drop silently (C23: the publish
 *     re-resolves the draft's relations against PUBLISHED rows with
 *     `allowMissingId`): `lesson.course` and `wiki-page.parent` must point
 *     at a document that has a published row. Departments and teams are
 *     single rows and never draft-only (decision 05).
 *
 * `mergedDraft` is the stored draft overlaid with a payload (15A's
 * crossCheck, early warning) or the stored draft itself (the
 * publish-readiness middleware, authoritative at every publish). A
 * relation value may be a documentId string, a row id, `{ documentId }`,
 * `{ id }`, a populated row, an array of those, or `{ set | connect: [...] }`
 * (the last connected target counts); `null`, `[]` and `{ set: [] }` mean
 * no target.
 *
 * `NotPublishableError` is the refusal: a Strapi `ValidationError` (400)
 * with `details.keys` and `details.codes: { <key>: 'notPublishable' }`, so
 * the web maps it like any field error and the admin panel shows its
 * message.
 *
 * THE MIDDLEWARE (`createPublishReadiness`, slot 6 of
 * bootstrap/document-middlewares.ts, inside the document lock's
 * transaction): on `publish`, and on `create`/`update` with `status:
 * 'published'` (which publish inside the action, C3), for the scheduled
 * types. Before the action it asks `publishBlockers` about the stored draft
 * (publish) or the stored draft overlaid with the payload (create/update);
 * after it, it checks that every readiness relation the draft holds is
 * still held by the new published row, so a target unpublished between the
 * check and the publish cannot drop the link either. Either failure throws
 * `NotPublishableError` and rolls the action back. It binds every source:
 * the web, the admin panel (C19) and the scheduler (which records
 * `scheduleError = notPublishable`).
 */

export const NOT_PUBLISHABLE = "notPublishable";

/** The to-one relations a publish must keep, per uid (C23). */
export const READINESS_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  [LESSON_UID]: ["course"],
  [WIKI_PAGE_UID]: ["parent"],
};

interface AttributeSchema {
  type?: string;
  required?: boolean;
  min?: number | string;
  minLength?: number;
  relation?: string;
  target?: string;
}

/** The slice of the Strapi instance the check uses. */
export interface PublishReadinessHost {
  getModel(uid: string): { attributes?: Record<string, AttributeSchema | undefined> } | undefined;
  db: {
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      findMany(params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
      count(params: Record<string, unknown>): Promise<number>;
    };
  };
}

/** 400 `ValidationError` naming the keys that block the publish. */
export class NotPublishableError extends errors.ValidationError {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    const sorted = [...new Set(keys)].sort();
    super(`This draft cannot be published yet: ${sorted.join(", ")}`, {
      keys: sorted,
      codes: Object.fromEntries(sorted.map((key) => [key, NOT_PUBLISHABLE])),
    });
    this.keys = sorted;
  }
}

const SKIPPED_TYPES: ReadonlySet<string> = new Set([
  "relation",
  "media",
  "component",
  "dynamiczone",
]);
const NUMBER_TYPES: ReadonlySet<string> = new Set(["integer", "biginteger", "float", "decimal"]);
const STRING_TYPES: ReadonlySet<string> = new Set([
  "string",
  "text",
  "richtext",
  "email",
  "password",
  "uid",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One relation reference: a documentId, or a row id to translate. */
type RelationRef = { documentId: string } | { id: number } | null;

function refOf(value: unknown): RelationRef {
  if (typeof value === "string") return value === "" ? null : { documentId: value };
  if (typeof value === "number") return Number.isInteger(value) ? { id: value } : null;
  if (Array.isArray(value)) return value.length === 0 ? null : refOf(value[value.length - 1]);
  if (!isRecord(value)) return null;
  if (Array.isArray(value.set)) return refOf(value.set);
  if (Array.isArray(value.connect) && value.connect.length > 0) return refOf(value.connect);
  if (typeof value.documentId === "string" && value.documentId !== "") {
    return { documentId: value.documentId };
  }
  if (typeof value.id === "number") return { id: value.id };
  return null;
}

/** The target's documentId for a reference, or null when it does not resolve. */
async function targetDocumentId(
  strapi: PublishReadinessHost,
  target: string,
  ref: Exclude<RelationRef, null>,
): Promise<string | null> {
  if ("documentId" in ref) return ref.documentId;
  const row = await strapi.db
    .query(target)
    .findOne({ where: { id: ref.id }, select: ["documentId"] });
  return typeof row?.documentId === "string" ? row.documentId : null;
}

async function hasPublishedRow(
  strapi: PublishReadinessHost,
  target: string,
  documentId: string,
): Promise<boolean> {
  const published = await strapi.db.query(target).count({
    where: { documentId, publishedAt: { $notNull: true } },
  });
  return published > 0;
}

/** The keys that block publishing `mergedDraft` of `uid` (see the module comment). */
export async function publishBlockers(
  strapi: PublishReadinessHost,
  uid: string,
  mergedDraft: Record<string, unknown>,
): Promise<string[]> {
  const attributes = strapi.getModel(uid)?.attributes ?? {};
  const draft = isRecord(mergedDraft) ? mergedDraft : {};
  const blockers: string[] = [];
  for (const [key, attribute] of Object.entries(attributes)) {
    if (!attribute?.type || SKIPPED_TYPES.has(attribute.type)) continue;
    const value = draft[key];
    if (attribute.required === true && (value === null || value === undefined)) {
      blockers.push(key);
      continue;
    }
    const min = attribute.min === undefined ? undefined : Number(attribute.min);
    if (
      NUMBER_TYPES.has(attribute.type) &&
      min !== undefined &&
      Number.isFinite(min) &&
      value !== null &&
      value !== undefined &&
      Number(value) < min
    ) {
      blockers.push(key);
      continue;
    }
    if (
      STRING_TYPES.has(attribute.type) &&
      typeof attribute.minLength === "number" &&
      typeof value === "string" &&
      value.length < attribute.minLength
    ) {
      blockers.push(key);
    }
  }
  for (const key of READINESS_RELATIONS[uid] ?? []) {
    const target = attributes[key]?.target;
    if (!target) continue;
    const ref = refOf(draft[key]);
    if (ref === null) continue;
    const documentId = await targetDocumentId(strapi, target, ref);
    if (documentId === null || !(await hasPublishedRow(strapi, target, documentId))) {
      blockers.push(key);
    }
  }
  return blockers.sort();
}

// ---------------------------------------------------------------------------
// The middleware.

interface ReadinessContext {
  uid?: string;
  action?: string;
  params?: unknown;
}

const PUBLISHING_WRITES: readonly string[] = ["create", "update"];

/** Whether this action publishes (C3: create/update with status 'published' do). */
export function publishesInAction(action: string | undefined, params: unknown): boolean {
  if (action === "publish") return true;
  return (
    PUBLISHING_WRITES.includes(action ?? "") && isRecord(params) && params.status === "published"
  );
}

const relationPopulate = (uid: string): Record<string, { select: string[] }> =>
  Object.fromEntries(
    (READINESS_RELATIONS[uid] ?? []).map((key) => [key, { select: ["documentId"] }]),
  );

/** The stored draft row of a document, with the readiness relations as `{ documentId }`. */
async function storedDraft(
  strapi: PublishReadinessHost,
  uid: string,
  documentId: string,
): Promise<Record<string, unknown> | null> {
  return strapi.db.query(uid).findOne({
    where: { documentId, publishedAt: null },
    populate: relationPopulate(uid),
  });
}

const RELATION_OPERATIONS = ["set", "connect", "disconnect"];

/**
 * The stored draft overlaid with a payload, as `publishBlockers` reads it.
 * A relation payload with operations keeps the stored value unless it sets
 * or connects a target (to-one: the last one counts) or only disconnects
 * (then no target remains); the Content Manager sends empty operations for
 * an untouched relation.
 */
export function overlayDraft(
  stored: Record<string, unknown> | null,
  data: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(stored ?? {}) };
  if (!isRecord(data)) return merged;
  for (const [key, value] of Object.entries(data)) {
    if (isRecord(value) && RELATION_OPERATIONS.some((operation) => operation in value)) {
      const set = value.set;
      const connect = Array.isArray(value.connect) ? value.connect : [];
      const disconnect = Array.isArray(value.disconnect) ? value.disconnect : [];
      if (Array.isArray(set)) merged[key] = set;
      else if (connect.length > 0) merged[key] = connect;
      else if (disconnect.length > 0) merged[key] = null;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** The documentId a populated to-one relation holds, or null. */
const linkedDocumentId = (row: Record<string, unknown> | undefined, key: string): string | null => {
  const value = row?.[key];
  return isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;
};

const isPublishedRow = (row: Record<string, unknown>) =>
  row.publishedAt !== null && row.publishedAt !== undefined;

/** After the publish: the readiness links of the draft the new published row lost. */
async function lostLinks(
  strapi: PublishReadinessHost,
  uid: string,
  documentId: string,
): Promise<string[]> {
  const keys = READINESS_RELATIONS[uid] ?? [];
  if (keys.length === 0) return [];
  const rows = await strapi.db.query(uid).findMany({
    where: { documentId },
    populate: relationPopulate(uid),
  });
  const draft = rows.find((row) => !isPublishedRow(row));
  const published = rows.find(isPublishedRow);
  if (!draft || !published) return [];
  return keys.filter(
    (key) => linkedDocumentId(draft, key) !== null && linkedDocumentId(published, key) === null,
  );
}

const documentIdOf = (params: unknown, result: unknown): string | null => {
  if (isRecord(params) && typeof params.documentId === "string" && params.documentId !== "") {
    return params.documentId;
  }
  if (isRecord(result) && typeof result.documentId === "string") return result.documentId;
  return null;
};

/** The publish-readiness middleware (see the module comment). */
export function createPublishReadiness(strapi: PublishReadinessHost) {
  return async (context: ReadinessContext, next: () => Promise<unknown>): Promise<unknown> => {
    const uid = context.uid;
    if (!isScheduledUid(uid) || !publishesInAction(context.action, context.params)) return next();
    const params = isRecord(context.params) ? context.params : {};
    const documentId = documentIdOf(params, null);
    const stored = documentId ? await storedDraft(strapi, uid, documentId) : null;
    // A publish of a document without a draft publishes nothing: Strapi's own answer.
    if (context.action === "publish" && stored === null) return next();
    const draft = context.action === "publish" ? (stored ?? {}) : overlayDraft(stored, params.data);
    const blockers = await publishBlockers(strapi, uid, draft);
    if (blockers.length > 0) throw new NotPublishableError(blockers);
    const result = await next();
    const published = documentIdOf(params, result);
    if (published) {
      const lost = await lostLinks(strapi, uid, published);
      if (lost.length > 0) throw new NotPublishableError(lost);
    }
    return result;
  };
}
