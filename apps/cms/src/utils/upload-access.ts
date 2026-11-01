/**
 * Who may open an uploaded file (v0.34, audit finding B1; deep-dive
 * plan-v034-rev3.md "B1 rule, final").
 *
 * Until v0.34 the /uploads proxy (apps/web/src/app/uploads/[...path]/route.ts)
 * served every file to every signed-in account, guests included: a
 * department-only document's file reached anyone who knew its URL, and
 * unpublishing or retargeting the document did not take it back. Now the
 * web asks POST /api/auth/uploads/access (api/upload-access) before it
 * fetches the bytes, and this module answers, for the viewer (the request's
 * users-permissions user) and one file name:
 *
 *   1. a moderator (admin_role, editor) may open every file;
 *   2. a file some row links (`files_related_mph`: a document's file, an ad's
 *      images, a course cover, a department header, a team or user avatar)
 *      opens only through a linking row the viewer may read IN THAT VERSION:
 *      a published (or draft-and-publish-less) row by the type's read rule,
 *      a draft row only by the authoring gate of that entry (a published
 *      sibling does not count). Inline references never widen a linked
 *      file: it follows the audience of the content it is attached to,
 *      wherever else it is linked from;
 *   3. a file nothing links opens for its uploader (the stamp the hardened
 *      POST /api/upload writes: the preview before the save), and, when it
 *      carries no stamp (an admin-panel upload), through a Markdown field of
 *      a row the viewer may read in that version that names it
 *      (UPLOAD_HOST_FIELDS). A stamped file never gains access inline: the
 *      uploads janitor removes unlinked stamped files after a day anyway;
 *   4. nothing else: the web answers 404 (no existence oracle).
 *
 * The read rules are the content API's own, reused, not rebuilt: the role's
 * findOne grant (up_permissions at the time of the read, loadRoleGrants)
 * plus the type's read-policy loader (document and course
 * departmentScopedIds, announcement visibleAnnouncementIds, lesson
 * lessonsOfPublishedCourses, wiki page visibleWikiIds); the user avatar
 * follows the directory (active users only, utils/user-visibility.ts). The
 * draft gates are the writers' (write-gate.ts roleClassFor and
 * departmentAuthorOwns, wiki-gate.ts wikiRowClass; courses and lessons are
 * authored by moderators only). A wiki revision opens for whoever may read
 * its page's history (the `revision` intent of the wiki gate).
 *
 * Inline references are `/uploads/<name>` in the text (relative or behind
 * any origin: the admin panel's Markdown editor inserts absolute URLs), of
 * the original or one of its renditions (`formats.*.url`), matched by
 * uploadReferenceNames on both sides: here, and in the write check
 * (utils/upload-reference-guard.ts), which refuses a non-moderator write
 * that adds a reference its writer could not open. What was stored before
 * v0.34 is reviewed once before the deploy (infra/diagnostics/
 * upload-references.sql).
 *
 * Every raw link read joins `trx` when given (the write check runs inside
 * the document lock's transaction; FX45, see upload-orphans.ts).
 */
import { MODERATORS, hasRole, type RoleHolder } from "../bootstrap/roles";
import { lessonsOfPublishedCourses } from "../policies/training-visibility";
import { visibleWikiIds } from "../policies/wiki-visibility";
import {
  ANNOUNCEMENT_UID,
  COURSE_UID,
  DEPARTMENT_UID,
  DOCUMENT_UID,
  EVENT_UID,
  LESSON_UID,
  TEAM_UID,
  WIKI_PAGE_UID,
} from "./authoring-uids";
import { CLASSIFIED_UID } from "./delete-audit";
import { departmentScopedIds, identifiedCaller } from "./policy-factories";
import { USER_UID } from "./sanitize-user-contact";
import { FILE_UID, fileLinks, uploadedByOf } from "./upload-orphans";
import { holdsGrant, loadRoleGrants, loadUserScope, visibleAnnouncementIds } from "./visible-ids";
import { callerScope, wikiRowClass } from "./wiki-gate";
import { WIKI_REVISION_UID } from "./wiki-revisions";
import { DEPARTMENT_AUTHOR_CLASS, type StrapiDb } from "./write-allowlist";
import {
  departmentAuthorOwns,
  loadCallerDepartment,
  loadDocumentRows,
  roleClassFor,
} from "./write-gate";

/**
 * The fields the web renders as Markdown, per type: the only text an inline
 * reference counts in. document.description and wiki-space.description are
 * shown as plain text and authorize nothing.
 */
export const UPLOAD_HOST_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [ANNOUNCEMENT_UID]: ["body"],
  [EVENT_UID]: ["description"],
  [WIKI_PAGE_UID]: ["body"],
  [WIKI_REVISION_UID]: ["body"],
  [LESSON_UID]: ["body"],
  [COURSE_UID]: ["description"],
  [DEPARTMENT_UID]: ["description"],
  [TEAM_UID]: ["description"],
};

/** The slice of the Strapi instance the decision uses (the real one in production). */
export type UploadAccessHost = any;

/** Types with draft & publish among the linking and host types. */
const DRAFT_AND_PUBLISH: ReadonlySet<string> = new Set([
  ANNOUNCEMENT_UID,
  EVENT_UID,
  DOCUMENT_UID,
  COURSE_UID,
  LESSON_UID,
  WIKI_PAGE_UID,
]);

/** The grant a row of each type needs: the type's findOne. */
const READ_GRANT: Readonly<Record<string, string>> = {
  [ANNOUNCEMENT_UID]: `${ANNOUNCEMENT_UID}.findOne`,
  [EVENT_UID]: `${EVENT_UID}.findOne`,
  [DOCUMENT_UID]: `${DOCUMENT_UID}.findOne`,
  [COURSE_UID]: `${COURSE_UID}.findOne`,
  [LESSON_UID]: `${LESSON_UID}.findOne`,
  [WIKI_PAGE_UID]: `${WIKI_PAGE_UID}.findOne`,
  [DEPARTMENT_UID]: `${DEPARTMENT_UID}.findOne`,
  [TEAM_UID]: `${TEAM_UID}.findOne`,
  [CLASSIFIED_UID]: `${CLASSIFIED_UID}.findOne`,
  [USER_UID]: `${USER_UID}.findOne`,
};

/** `/uploads/<name>`: one path segment, up to whitespace, quotes, brackets, `?` or `#`. */
const UPLOAD_REFERENCE = /\/uploads\/([^\s/"'<>()[\]\\?#]+)/g;

/** Sentence punctuation that may follow a bare reference in prose. */
const TRAILING_PUNCTUATION = /[.,;:!]+$/;

/**
 * Every file name a text references as `/uploads/<name>` (relative, or
 * behind any origin). One reader for the access decision and the write
 * check, so the two can never disagree about what a text names.
 */
export function uploadReferenceNames(text: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof text !== "string" || !text.includes("/uploads/")) return names;
  for (const match of text.matchAll(UPLOAD_REFERENCE)) {
    const name = match[1]!.replace(TRAILING_PUNCTUATION, "");
    if (name !== "") names.add(name);
  }
  return names;
}

/** One stored file as the decision reads it. */
export interface UploadFile {
  id: number;
  /** The names of the original and every rendition (`<name>` of `/uploads/<name>`). */
  names: string[];
  /** The uploader's user id, or null for an admin-panel upload. */
  uploadedBy: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UPLOADS_PREFIX = "/uploads/";

const nameOf = (url: unknown): string | null =>
  typeof url === "string" && url.startsWith(UPLOADS_PREFIX)
    ? url.slice(UPLOADS_PREFIX.length)
    : null;

function formatsOf(row: Record<string, unknown>): Record<string, unknown> {
  let formats: unknown = row.formats;
  if (typeof formats === "string") {
    try {
      formats = JSON.parse(formats);
    } catch {
      return {};
    }
  }
  return isRecord(formats) ? formats : {};
}

function toFile(row: unknown): UploadFile | null {
  if (!isRecord(row) || typeof row.id !== "number") return null;
  const names = new Set<string>();
  const original = nameOf(row.url);
  if (original) names.add(original);
  for (const format of Object.values(formatsOf(row))) {
    const name = isRecord(format) ? nameOf(format.url) : null;
    if (name) names.add(name);
  }
  return { id: row.id, names: [...names], uploadedBy: uploadedByOf(row) };
}

const FILE_SELECT = ["id", "url", "formats", "provider_metadata"];

/**
 * The stored file `/uploads/<name>` names: its original URL, or one of its
 * renditions (`<format>_<original name>`, confirmed against the stored
 * `formats` URLs, never trusted from the prefix alone). null when no file
 * has that URL.
 */
export async function resolveUploadFile(strapi: UploadAccessHost, name: string): Promise<UploadFile | null> {
  if (name === "" || name.includes("/")) return null;
  const files = strapi.db.query(FILE_UID);
  const exact = toFile(
    await files.findOne({ where: { url: `${UPLOADS_PREFIX}${name}` }, select: FILE_SELECT }),
  );
  if (exact) return exact;
  const rendition = /^[A-Za-z0-9-]+_(.+)$/.exec(name);
  if (!rendition) return null;
  const original = toFile(
    await files.findOne({
      where: { url: `${UPLOADS_PREFIX}${rendition[1]}` },
      select: FILE_SELECT,
    }),
  );
  return original && original.names.includes(name) ? original : null;
}

/** The viewer as the request's users-permissions user (role populated). */
export interface UploadViewer extends RoleHolder {
  id: number;
}

/** What one decision reads once: the viewer's scope and the read grants. */
interface Reader {
  strapi: UploadAccessHost;
  viewer: UploadViewer;
  grants(): Promise<(action: string) => boolean>;
  visible(key: string, load: () => Promise<readonly number[]>): Promise<ReadonlySet<number>>;
}

function readerFor(strapi: UploadAccessHost, viewer: UploadViewer): Reader {
  let grants: Promise<(action: string) => boolean> | null = null;
  const visible = new Map<string, Promise<ReadonlySet<number>>>();
  return {
    strapi,
    viewer,
    grants() {
      grants ??= (async () => {
        const [scope, roles] = await Promise.all([
          loadUserScope(strapi, viewer.id),
          loadRoleGrants(strapi, Object.values(READ_GRANT)),
        ]);
        return (action: string) => holdsGrant(scope, roles.holders(action));
      })();
      return grants;
    },
    visible(key, load) {
      let ids = visible.get(key);
      if (!ids) {
        ids = load().then((list) => new Set(list));
        visible.set(key, ids);
      }
      return ids;
    },
  };
}

/** The read-policy loader of a type, for the row ids the viewer may read. */
async function policyAllows(reader: Reader, uid: string, rowId: number): Promise<boolean> {
  const { strapi, viewer } = reader;
  const user = identifiedCaller(viewer);
  const input = { strapi, user, config: undefined, uid };
  let ids: ReadonlySet<number>;
  switch (uid) {
    case DOCUMENT_UID:
    case COURSE_UID:
      ids = await reader.visible(uid, () => departmentScopedIds(input));
      break;
    case ANNOUNCEMENT_UID:
      ids = await reader.visible(uid, () => visibleAnnouncementIds(input));
      break;
    case LESSON_UID:
      ids = await reader.visible(uid, () =>
        lessonsOfPublishedCourses({ ...input, config: { level: "lesson" } }),
      );
      break;
    case WIKI_PAGE_UID:
      ids = await reader.visible(uid, () =>
        visibleWikiIds({ ...input, config: { level: "page" } }),
      );
      break;
    default:
      // event, department, team, classified: the grant is the whole rule.
      return true;
  }
  return ids.has(rowId);
}

/** May the viewer author this draft (the writers' gates)? Moderators are decided before. */
async function draftAllows(reader: Reader, uid: string, documentId: string): Promise<boolean> {
  const { strapi, viewer } = reader;
  if (uid === WIKI_PAGE_UID) return wikiPageAllows(reader, documentId);
  if (uid !== ANNOUNCEMENT_UID && uid !== EVENT_UID && uid !== DOCUMENT_UID) return false;
  if (roleClassFor(viewer, uid) !== DEPARTMENT_AUTHOR_CLASS) return false;
  const [rows, department] = await Promise.all([
    loadDocumentRows(strapi, uid, documentId),
    loadCallerDepartment(strapi, viewer.id),
  ]);
  return departmentAuthorOwns(uid, rows, department);
}

/** The wiki gate's class on a page (drafts, history): non-null opens. */
async function wikiPageAllows(reader: Reader, documentId: string): Promise<boolean> {
  const { strapi, viewer } = reader;
  const extras = await callerScope(strapi, viewer, false);
  const rows = await loadDocumentRows(strapi, WIKI_PAGE_UID, documentId);
  return (await wikiRowClass(strapi as StrapiDb, extras, rows)) !== null;
}

const ROW_SELECT: Readonly<Record<string, readonly string[]>> = {
  [USER_UID]: ["id", "blocked"],
  [WIKI_REVISION_UID]: ["id", "pageDocumentId"],
};

/** May the viewer read this one row, in this version? */
async function rowAllows(reader: Reader, uid: string, rowId: number): Promise<boolean> {
  if (uid !== WIKI_REVISION_UID && !(uid in READ_GRANT)) return false;
  const select = ROW_SELECT[uid] ?? [
    "id",
    "documentId",
    ...(DRAFT_AND_PUBLISH.has(uid) ? ["publishedAt"] : []),
  ];
  const row = await reader.strapi.db.query(uid).findOne({ where: { id: rowId }, select });
  if (!isRecord(row)) return false;
  if (uid === WIKI_REVISION_UID) {
    return typeof row.pageDocumentId === "string" && wikiPageAllows(reader, row.pageDocumentId);
  }
  if (DRAFT_AND_PUBLISH.has(uid) && row.publishedAt == null) {
    return typeof row.documentId === "string" && draftAllows(reader, uid, row.documentId);
  }
  if (!(await reader.grants())(READ_GRANT[uid]!)) return false;
  // The directory: blocked people are gone from it (utils/user-visibility.ts).
  if (uid === USER_UID) return row.blocked !== true;
  return policyAllows(reader, uid, rowId);
}

/** The rows whose Markdown fields name one of `names`, per host type. */
async function inlineHosts(
  strapi: UploadAccessHost,
  names: readonly string[],
): Promise<Array<{ uid: string; id: number }>> {
  const hosts: Array<{ uid: string; id: number }> = [];
  for (const [uid, fields] of Object.entries(UPLOAD_HOST_FIELDS)) {
    // LIKE narrows (its `_` matches any character); uploadReferenceNames decides.
    const rows: unknown[] = await strapi.db.query(uid).findMany({
      where: {
        $or: fields.flatMap((field) =>
          names.map((name) => ({ [field]: { $contains: `${UPLOADS_PREFIX}${name}` } })),
        ),
      },
      select: ["id", ...fields],
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isRecord(row) || typeof row.id !== "number") continue;
      const named = fields.some((field) => {
        const found = uploadReferenceNames(row[field]);
        return names.some((name) => found.has(name));
      });
      if (named) hosts.push({ uid, id: row.id });
    }
  }
  return hosts;
}

/**
 * May `viewer` open the file `/uploads/<name>` (see the header)? `trx`: the
 * caller's transaction, for the write check.
 */
export async function mayOpenUpload(
  strapi: UploadAccessHost,
  viewer: UploadViewer,
  name: string,
  trx?: unknown,
): Promise<boolean> {
  if (hasRole(viewer, MODERATORS)) return true;
  const file = await resolveUploadFile(strapi, name);
  if (!file) return false;
  return mayOpenFile(strapi, viewer, file, trx);
}

/** mayOpenUpload for a file already resolved (the write check resolves first). */
export async function mayOpenFile(
  strapi: UploadAccessHost,
  viewer: UploadViewer,
  file: UploadFile,
  trx?: unknown,
): Promise<boolean> {
  if (hasRole(viewer, MODERATORS)) return true;
  const reader = readerFor(strapi, viewer);
  const links = await fileLinks(strapi, file.id, trx);
  if (links.length > 0) {
    for (const link of links) {
      if (await rowAllows(reader, link.relatedType, link.relatedId)) return true;
    }
    return false;
  }
  if (file.uploadedBy !== null) return file.uploadedBy === viewer.id;
  for (const host of await inlineHosts(strapi, file.names)) {
    if (await rowAllows(reader, host.uid, host.id)) return true;
  }
  return false;
}
