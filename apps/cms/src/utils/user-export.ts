import type { UserExport } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { recordAuditEvent, type AuditHost } from "./audit";
import { parseSnapshot, publicationStamp } from "./training-evidence";
import { uploadedByOf } from "./upload-orphans";

/**
 * The data export of one person (GDPR Art. 15; v0.28, deep-dive
 * plan-v028-rev2.md §3): GET /api/user-management/:id/export, admin_role
 * only (the controller and the caller check of utils/user-admin.ts).
 *
 * EXPLICIT PROJECTIONS. Every section names its columns; no secret (password
 * hash, tokens, TOTP secret and codes, token version) is ever selected. The
 * person's own private profile fields (birthday, digest settings, the
 * identity-provider ids) are in, because they are theirs.
 *
 * COMPLETE. `CONTENT_RELATIONS` lists every relation to the user model the
 * content types have, each read whole in id pages; the user's own relations
 * are `organisation`; JSON and upload sources follow (duty shifts, stamped
 * uploads); the audit trail by actor and by target. export-coverage.test.ts
 * walks the schemas and fails on a relation to the user model that is in
 * neither list. A walk longer than EXPORT_MAX_ROWS fails the export rather
 * than cutting it. Draft-and-publish types list each stored state
 * (`publishedAt` null = the draft).
 *
 * NOT INCLUDED (`notIncluded`, with the reason the data subject reads): see
 * NOT_INCLUDED. The rows are read one after another, not from one database
 * snapshot (`meta.generatedAt`). The export works whatever FEATURES_OFF
 * says: it is a rights operation, not a module.
 */

const USER_UID = "plugin::users-permissions.user";
const FILE_UID = "plugin::upload.file";
const AUDIT_UID = "api::audit-event.audit-event";
const PAGE = 500;
/** Rows per class at most; more fails the export instead of truncating it. */
export const EXPORT_MAX_ROWS = 100_000;

type Row = Record<string, unknown>;

export interface ExportHost extends Omit<AuditHost, "db"> {
  db: {
    query(uid: string): {
      findOne(params: Row): Promise<unknown>;
      findMany(params: Row): Promise<unknown>;
      create(params: { data: Row }): Promise<unknown>;
    };
  };
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const iso = (value: unknown): string | null => publicationStamp(value) ?? text(value);
const nameOf = (value: unknown): string | null =>
  isRecord(value) ? text(value.displayName) || text(value.username) : null;

/** One relation to the user model: where the person is linked, and what of the row is theirs. */
export interface ExportRelation {
  /** The section key in `content`. */
  key: string;
  uid: string;
  field: string;
  select: string[];
  populate?: Row;
  /** The row as exported (default: the selected columns, instants as ISO). */
  map?: (row: Row) => Row;
}

const DOC = ["documentId", "createdAt", "updatedAt", "publishedAt"];

/** Every relation to the user model outside the user type itself (export-coverage.test.ts). */
export const CONTENT_RELATIONS: readonly ExportRelation[] = [
  {
    key: "announcements",
    uid: "api::announcement.announcement",
    field: "author",
    select: ["title", ...DOC],
  },
  {
    key: "wikiPagesAuthored",
    uid: "api::wiki-page.wiki-page",
    field: "author",
    select: ["title", ...DOC],
  },
  {
    key: "wikiPagesLastEdited",
    uid: "api::wiki-page.wiki-page",
    field: "lastEditor",
    select: ["title", ...DOC],
  },
  {
    key: "wikiRevisions",
    uid: "api::wiki-revision.wiki-revision",
    field: "editor",
    select: ["pageDocumentId", "title", "kind", "summary", "createdAt"],
  },
  {
    key: "documents",
    uid: "api::document.document",
    field: "uploadedBy",
    select: ["title", "category", ...DOC],
  },
  {
    key: "events",
    uid: "api::event.event",
    field: "organizer",
    select: ["title", "start", "end", "location", ...DOC],
  },
  {
    key: "polls",
    uid: "api::poll.poll",
    field: "author",
    select: ["question", "closesAt", "anonymous", ...DOC],
  },
  { key: "dutyPlans", uid: "api::duty-plan.duty-plan", field: "author", select: ["name", ...DOC] },
  { key: "kpis", uid: "api::kpi.kpi", field: "author", select: ["name", ...DOC] },
  {
    key: "classifieds",
    uid: "api::classified.classified",
    field: "author",
    select: [
      "documentId",
      "title",
      "description",
      "category",
      "price",
      "location",
      "expiresAt",
      "createdAt",
    ],
    populate: { images: { select: ["name"] } },
    map: (row) => ({
      ...pick(row, [
        "documentId",
        "title",
        "description",
        "category",
        "price",
        "location",
        "expiresAt",
        "createdAt",
      ]),
      images: (Array.isArray(row.images) ? row.images : []).map((image) =>
        isRecord(image) ? image.name : null,
      ),
    }),
  },
  {
    key: "comments",
    uid: "api::comment.comment",
    field: "author",
    select: ["body", "targetType", "targetDocumentId", "createdAt"],
  },
  {
    key: "kudosGiven",
    uid: "api::kudos.kudos",
    field: "from",
    select: ["message", "value", "createdAt"],
    populate: { to: { select: ["displayName", "username"] } },
    map: (row) => ({ ...pick(row, ["message", "value", "createdAt"]), to: nameOf(row.to) }),
  },
  {
    key: "kudosReceived",
    uid: "api::kudos.kudos",
    field: "to",
    select: ["message", "value", "createdAt"],
    populate: { from: { select: ["displayName", "username"] } },
    map: (row) => ({ ...pick(row, ["message", "value", "createdAt"]), from: nameOf(row.from) }),
  },
  {
    key: "reactions",
    uid: "api::reaction.reaction",
    field: "author",
    select: ["emoji", "targetType", "targetDocumentId", "createdAt"],
  },
  {
    key: "pollVotes",
    uid: "api::poll-vote.poll-vote",
    field: "voter",
    select: ["optionIndex", "createdAt"],
    populate: { poll: { select: ["documentId", "question", "options"] } },
    map: (row) => {
      const poll = isRecord(row.poll) ? row.poll : null;
      const options = Array.isArray(poll?.options) ? poll.options : [];
      const index = typeof row.optionIndex === "number" ? row.optionIndex : -1;
      return {
        poll: poll ? { documentId: poll.documentId, question: poll.question } : null,
        option: options[index] ?? null,
        createdAt: iso(row.createdAt),
      };
    },
  },
  {
    key: "rsvps",
    uid: "api::event-rsvp.event-rsvp",
    field: "user",
    select: ["targetDocumentId", "status", "respondedAt"],
  },
  {
    key: "acknowledgements",
    uid: "api::acknowledgement.acknowledgement",
    field: "user",
    select: ["targetType", "targetDocumentId", "acknowledgedAt"],
  },
  {
    key: "trainingReceipts",
    uid: "api::lesson-progress.lesson-progress",
    field: "user",
    select: ["targetDocumentId", "completedAt", "snapshot"],
    map: (row) => ({
      lessonDocumentId: row.targetDocumentId,
      completedAt: iso(row.completedAt),
      snapshot: parseSnapshot(row.snapshot),
    }),
  },
  {
    key: "notifications",
    uid: "api::notification.notification",
    field: "recipient",
    select: ["type", "title", "link", "createdAt", "readAt"],
  },
  {
    // Rows of OTHER people naming the person: never their recipient.
    key: "notificationsNamingYou",
    uid: "api::notification.notification",
    field: "actor",
    select: ["type", "createdAt"],
  },
  {
    key: "departmentHeadOf",
    uid: "api::department.department",
    field: "head",
    select: ["documentId", "name"],
  },
  { key: "teamLeadOf", uid: "api::team.team", field: "lead", select: ["documentId", "name"] },
  // department.members and team.members are the inverse sides of user.department
  // and user.teams: `organisation` lists them.
];

/** The inverse sides `organisation` covers (export-coverage.test.ts). */
export const ORGANISATION_RELATIONS = [
  "api::department.department.members",
  "api::team.team.members",
  `${USER_UID}.manager`,
  `${USER_UID}.directReports`,
];

/** What the export does not hold, and why (shown to the data subject as is). */
export const NOT_INCLUDED = [
  {
    category: "Suchanfragen / search queries",
    reason:
      "Stored without any link to a person, so they cannot be attributed; a query may still contain a name (see the data inventory). Deleted after SEARCH_LOG_RETENTION_DAYS.",
  },
  {
    category:
      "Wiki-Versionstexte und Freitext anderer / wiki revision bodies and other people's free text",
    reason:
      "Business content that may mention the person. Reviewed by hand as part of this request on demand; third parties' rights are weighed.",
  },
  {
    category: "Audit-Details / audit details",
    reason:
      "The `detail` column can hold third-party data (titles, file names). The export lists time, action, type and document id; the details are reviewed by hand on demand.",
  },
  {
    category: "Sicherungen / backups",
    reason: "Restored only after a disaster; they rotate and are deleted on schedule.",
  },
  {
    category: "Strapi-Administratorkonten / Strapi admin accounts",
    reason: "A separate system for technical administration; exported on request by the operator.",
  },
];

function pick(row: Row, keys: string[]): Row {
  const out: Row = {};
  for (const key of keys) {
    const value = row[key];
    out[key] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  return out;
}

async function walk(strapi: ExportHost, uid: string, where: Row, select: string[], populate?: Row) {
  const out: Row[] = [];
  let afterId = 0;
  for (;;) {
    const page = (await strapi.db.query(uid).findMany({
      where: { $and: [where, { id: { $gt: afterId } }] },
      select: ["id", ...select],
      ...(populate ? { populate } : {}),
      orderBy: [{ id: "asc" }],
      limit: PAGE,
    })) as unknown;
    const rows = Array.isArray(page) ? page.filter(isRecord) : [];
    if (rows.length === 0) return out;
    out.push(...rows);
    if (out.length > EXPORT_MAX_ROWS) {
      throw new errors.ApplicationError(`The export of ${uid} exceeds ${EXPORT_MAX_ROWS} rows`);
    }
    afterId = rows[rows.length - 1].id as number;
  }
}

const ACCOUNT_FIELDS = [
  "documentId",
  "username",
  "email",
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
  "hireDate",
  "birthday",
  "birthdayVisible",
  "locale",
  "digestAnnouncements",
  "digestMentions",
  "digestKudos",
  "digestFrequency",
  "lastDigestAt",
  "provider",
  "roleSource",
  "entraTenantId",
  "microsoftOid",
  "oidcIssuer",
  "oidcSubject",
  "totpEnabledAt",
  "confirmed",
  "blocked",
  "anonymisedAt",
  "createdAt",
  "updatedAt",
];

/** The export (see the module comment); 404 for an unknown id. Records the `export` audit row. */
export async function exportUser(
  strapi: ExportHost,
  id: number,
  callerId: number,
  instance: string | null,
): Promise<UserExport> {
  const generatedAt = new Date().toISOString();
  const user = await strapi.db.query(USER_UID).findOne({
    where: { id },
    select: ["id", ...ACCOUNT_FIELDS],
    populate: {
      role: { select: ["type", "name"] },
      avatar: { select: ["name"] },
      department: { select: ["documentId", "name"] },
      teams: { select: ["documentId", "name"] },
      manager: { select: ["id", "displayName", "username"] },
      directReports: { select: ["id", "displayName", "username"] },
    },
  });
  if (!isRecord(user)) throw new errors.NotFoundError("Not Found");

  const account: Row = { id, ...pick(user, ACCOUNT_FIELDS) };
  account.role = isRecord(user.role) ? user.role.type : null;
  account.avatar = isRecord(user.avatar) ? user.avatar.name : null;
  account.totpEnabled = user.totpEnabledAt != null;

  const ref = (value: unknown) =>
    isRecord(value) ? { documentId: value.documentId ?? null, name: value.name ?? null } : null;
  const person = (value: unknown) =>
    isRecord(value) ? { id: value.id, displayName: nameOf(value) } : null;
  const organisation: Row = {
    department: ref(user.department),
    teams: (Array.isArray(user.teams) ? user.teams : []).map(ref),
    manager: person(user.manager),
    directReports: (Array.isArray(user.directReports) ? user.directReports : []).map(person),
  };

  const content: Record<string, Row[]> = {};
  for (const relation of CONTENT_RELATIONS) {
    const rows = await walk(
      strapi,
      relation.uid,
      { [relation.field]: { id } },
      relation.select,
      relation.populate,
    );
    content[relation.key] = rows.map((row) =>
      relation.map ? relation.map(row) : pick(row, relation.select),
    );
  }
  content.dutyShifts = await dutyShifts(strapi, id);
  content.uploads = await stampedUploads(strapi, id);

  const documentId = text(user.documentId);
  const targets = documentId ? [documentId, String(id)] : [String(id)];
  const audit = (
    await walk(
      strapi,
      AUDIT_UID,
      {
        $or: [
          { actorKind: "user", actorUserId: id },
          { targetUid: USER_UID, targetDocumentId: { $in: targets } },
        ],
      },
      [
        "createdAt",
        "action",
        "targetUid",
        "targetDocumentId",
        "actorKind",
        "actorUserId",
        "source",
      ],
    )
  ).map((row) => ({
    at: iso(row.createdAt),
    action: row.action,
    type: row.targetUid,
    documentId: row.targetDocumentId,
    role: row.actorKind === "user" && row.actorUserId === id ? "actor" : "target",
    source: row.source,
  }));

  await recordAuditEvent(strapi, {
    action: "export",
    targetUid: USER_UID,
    targetDocumentId: documentId ?? String(id),
    actorKind: "user",
    actorUserId: callerId,
    actorClass: "moderator",
    source: "content-api",
  });

  return {
    meta: { generatedAt, instance, inventory: "docs/data-protection.md" },
    account,
    organisation,
    content,
    audit,
    notIncluded: NOT_INCLUDED,
  };
}

/** Every shift of every duty plan (each stored state) that names the person. */
async function dutyShifts(strapi: ExportHost, id: number): Promise<Row[]> {
  const plans = await walk(strapi, "api::duty-plan.duty-plan", {}, [
    "documentId",
    "name",
    "publishedAt",
    "shifts",
  ]);
  const out: Row[] = [];
  for (const plan of plans) {
    for (const shift of Array.isArray(plan.shifts) ? plan.shifts : []) {
      if (!isRecord(shift) || shift.userId !== id) continue;
      out.push({
        plan: { documentId: plan.documentId, name: plan.name, publishedAt: iso(plan.publishedAt) },
        startsAt: shift.startsAt ?? null,
        endsAt: shift.endsAt ?? null,
      });
    }
  }
  return out;
}

/** Files the hardened upload stamped with the person (utils/upload-orphans.ts). */
async function stampedUploads(strapi: ExportHost, id: number): Promise<Row[]> {
  const files = await walk(strapi, FILE_UID, {}, [
    "name",
    "mime",
    "size",
    "createdAt",
    "provider_metadata",
  ]);
  return files
    .filter((file) => uploadedByOf(file) === id)
    .map((file) => ({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      createdAt: iso(file.createdAt),
    }));
}
