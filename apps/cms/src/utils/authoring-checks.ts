import { MEDIA_CLAIM_FIELDS } from "./media-fields";

import { isRoleType } from "../bootstrap/roles";
import { COURSE_UID, DEPARTMENT_UID, TEAM_UID } from "./authoring-uids";
import { isTombstoned, uploadedByOf } from "./upload-orphans";
import type {
  FrozenCheck,
  FrozenCheckName,
  MediaCheck,
  MediaCheckName,
  AuthoringRelationCheckName,
  RelationCheck,
  RelationListCheck,
  RelationListCheckName,
  RelationRef,
  ResolvedToOne,
  RoleTypesCheck,
} from "./write-allowlist";

const USER_UID = "plugin::users-permissions.user";

/**
 * The database-backed checks the v2 write gate hands to the allowlist
 * (deep-dive decision 06 §B1.2, §E2, §N4; batch 15 plan item 5). Each one
 * resolves what a payload names to documentIds (or a file id) through
 * `strapi.db.query` and answers null for anything it cannot use, so the
 * allowlist refuses the field with its one generic message and no code:
 * a missing, foreign or out-of-scope target answers exactly like a
 * malformed one (no existence oracle).
 *
 *   - `department`, `team`, `departments`: any department or team. They are
 *     single rows since decision 05 and every staff member reads them, so
 *     naming one reveals nothing a moderator cannot read anyway;
 *   - every to-one check here takes exactly one target or a clear (null):
 *     a disconnect or a shape that names nothing (`{ connect: [] }`) is
 *     refused, so a targeting key in a payload always says where the item
 *     points afterwards (a no-op could otherwise skip the department pin on
 *     create and still re-derive the audience flag);
 *   - `callerDepartment` (to-one) and `callerDepartments` (to-many): exactly
 *     the department author's own department; `null`, `[]`, another
 *     department or a second one are refused (§N4);
 *   - `teamOfCallerDepartment`: `null`, or a team whose department is the
 *     caller's;
 *   - role types: resolved to the users-permissions role documentIds; the
 *     allowlist already refused `public`, `authenticated` and anything not
 *     allowed for the class, so the editor needs no `role.find` (C21);
 *   - `ownUpload` (§E2, `document.file` since batch 16): a NEWLY attached
 *     file must be stamped `provider_metadata.uploadedBy = caller`, have a
 *     sniffed mime of the field's list, carry no tombstone (a removal has
 *     reserved it, utils/upload-orphans.ts) and be linked by nothing but
 *     this document's own rows. An early refusal before the transaction:
 *     the media claims (utils/media-claims.ts, document-middlewares slot 7)
 *     check the same under the file row's lock at the write.
 *     Keeping the stored file is not an attachment: the allowlist passes
 *     it unchecked (the retain rule);
 *   - `pollHasVotes`: a ballot exists for any row of the poll (votes follow
 *     the published row across a republish, §5.17).
 */

export const ROLE_UID = "plugin::users-permissions.role";
export const FILE_UID = "plugin::upload.file";
export const POLL_VOTE_UID = "api::poll-vote.poll-vote";

/** Mimes a document file may have (§E1, amendment 2: the upload table's stored mimes). */
export const DOCUMENT_FILE_MIMES: ReadonlySet<string> = new Set(
  MEDIA_CLAIM_FIELDS["api::document.document"].file,
);

interface Row {
  id?: unknown;
  documentId?: unknown;
  [key: string]: unknown;
}

/** The slice of `strapi` the checks use. */
export interface AuthoringChecksHost {
  db: {
    query(uid: string): {
      findOne(params: object): Promise<unknown>;
      findMany(params: object): Promise<unknown>;
      count(params: object): Promise<number>;
    };
  };
}

/** The caller's own department, as the gate loaded it (§N1). */
export interface CallerDepartment {
  id: number;
  documentId: string;
}

export interface AuthoringCheckContext {
  callerId: number;
  /** The department author's department; null for moderators. */
  callerDepartment: CallerDepartment | null;
  /** The content type written (media links of its own rows are fine). */
  uid: string;
  /** The document an update changes (none on create). */
  documentId?: string;
  /** The row ids of that document (its draft and published twin). */
  ownRowIds: readonly number[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const whereOf = (ref: RelationRef) =>
  "id" in ref ? { id: ref.id } : { documentId: ref.documentId };

/** The row a ref names (id or documentId), or null. */
async function rowOf(
  strapi: AuthoringChecksHost,
  uid: string,
  ref: RelationRef,
  populate?: object,
): Promise<Row | null> {
  const row = (await strapi.db.query(uid).findOne({
    where: whereOf(ref),
    ...(populate ? { populate } : {}),
  })) as Row | null;
  return isRecord(row) && typeof row.documentId === "string" ? row : null;
}

/** A to-one check: every target and disconnect resolves (and passes `accept`). */
function toOneCheck(
  strapi: AuthoringChecksHost,
  uid: string,
  accept: (row: Row) => boolean = () => true,
  { allowClear = true, allowDisconnect = true, requireTarget = false, populate }: ToOneOptions = {},
): RelationCheck {
  return async (input): Promise<ResolvedToOne | null> => {
    if (input.target === null && !allowClear) return null;
    if (input.disconnect.length > 0 && !allowDisconnect) return null;
    if (input.target === undefined && requireTarget) return null;
    let target: string | null | undefined = input.target === null ? null : undefined;
    if (input.target) {
      const row = await rowOf(strapi, uid, input.target, populate);
      if (!row || !accept(row)) return null;
      target = row.documentId as string;
    }
    const disconnect: string[] = [];
    for (const ref of input.disconnect) {
      const row = await rowOf(strapi, uid, ref);
      if (!row) return null;
      disconnect.push(row.documentId as string);
    }
    return { target, disconnect };
  };
}

interface ToOneOptions {
  allowClear?: boolean;
  allowDisconnect?: boolean;
  /** Refuse a shape that names no target (a no-op such as `{ connect: [] }`). */
  requireTarget?: boolean;
  populate?: object;
}

/** A to-many check: every ref resolves (and passes `accept`); duplicates collapse. */
function listCheck(
  strapi: AuthoringChecksHost,
  uid: string,
  accept: (row: Row) => boolean = () => true,
): RelationListCheck {
  return async (refs) => {
    const documentIds: string[] = [];
    for (const ref of refs) {
      const row = await rowOf(strapi, uid, ref);
      if (!row || !accept(row)) return null;
      if (!documentIds.includes(row.documentId as string)) {
        documentIds.push(row.documentId as string);
      }
    }
    return documentIds;
  };
}

/** The department a team belongs to (id), from a populated team row. */
const teamDepartmentId = (row: Row): number | null => {
  const department = row.department;
  return isRecord(department) && typeof department.id === "number" ? department.id : null;
};

/** Role types → users-permissions role documentIds (exact types, intranet roles only). */
function roleTypesCheck(strapi: AuthoringChecksHost): RoleTypesCheck {
  return async (types) => {
    if (!types.every((type) => isRoleType(type))) return null;
    const rows = (await strapi.db.query(ROLE_UID).findMany({
      where: { type: { $in: types } },
      select: ["id", "documentId", "type"],
    })) as Row[];
    const documentIds: string[] = [];
    for (const type of types) {
      const row = rows.find((candidate) => candidate.type === type);
      if (!row || typeof row.documentId !== "string") return null;
      documentIds.push(row.documentId);
    }
    return documentIds;
  };
}

/** `ownUpload` (§E2): stamped by the caller, an allowed mime, linked by nothing else. */
function ownUploadCheck(strapi: AuthoringChecksHost, context: AuthoringCheckContext): MediaCheck {
  return async (fileId, field) => {
    const file = (await strapi.db.query(FILE_UID).findOne({
      where: { id: fileId },
      populate: { related: true },
    })) as Row | null;
    if (!isRecord(file) || uploadedByOf(file) !== context.callerId) return null;
    if (isTombstoned(file)) return null;
    if (
      typeof file.mime !== "string" ||
      !MEDIA_CLAIM_FIELDS[context.uid]?.[field]?.includes(file.mime)
    )
      return null;
    const related = Array.isArray(file.related) ? (file.related as Row[]) : [];
    const foreign = related.some(
      (link) =>
        (typeof link.__type === "string" && link.__type !== context.uid) ||
        typeof link.id !== "number" ||
        !context.ownRowIds.includes(link.id),
    );
    return foreign ? null : fileId;
  };
}

/** Whether any ballot exists for the poll document `documentId`. */
export async function pollHasVotes(
  strapi: AuthoringChecksHost,
  documentId: string,
): Promise<boolean> {
  const count = await strapi.db.query(POLL_VOTE_UID).count({ where: { poll: { documentId } } });
  return count > 0;
}

/** The authoring to-one shape: one target or null, never a disconnect or a no-op. */
const EXACTLY_ONE_OR_CLEAR: ToOneOptions = { allowDisconnect: false, requireTarget: true };

/** Every check of the authoring rules, bound to one request. */
export function authoringChecks(
  strapi: AuthoringChecksHost,
  context: AuthoringCheckContext,
): {
  relationChecks: Partial<Record<AuthoringRelationCheckName, RelationCheck>>;
  relationListChecks: Partial<Record<RelationListCheckName, RelationListCheck>>;
  roleTypesCheck: RoleTypesCheck;
  mediaChecks: Partial<Record<MediaCheckName, MediaCheck>>;
  frozenChecks: Partial<Record<FrozenCheckName, FrozenCheck>>;
} {
  const mine = context.callerDepartment;
  const isMine = (row: Row) => mine !== null && row.id === mine.id;
  const inMine = (row: Row) => mine !== null && teamDepartmentId(row) === mine.id;
  const refuse: RelationCheck = async () => null;
  const refuseList: RelationListCheck = async () => null;
  const callerDepartments: RelationListCheck = async (refs) => {
    // Exactly the caller's department: [] (company-wide) and a second
    // department are refused like any other value (§N4).
    if (!mine || refs.length === 0) return null;
    const documentIds = await listCheck(strapi, DEPARTMENT_UID, isMine)(refs);
    return documentIds && documentIds.length === 1 ? documentIds : null;
  };
  const documentId = context.documentId;
  return {
    relationChecks: {
      course: toOneCheck(strapi, COURSE_UID, undefined, {
        ...EXACTLY_ONE_OR_CLEAR,
        allowClear: false,
      }),
      department: toOneCheck(strapi, DEPARTMENT_UID, undefined, EXACTLY_ONE_OR_CLEAR),
      team: toOneCheck(strapi, TEAM_UID, undefined, EXACTLY_ONE_OR_CLEAR),
      callerDepartment: mine
        ? toOneCheck(strapi, DEPARTMENT_UID, isMine, { ...EXACTLY_ONE_OR_CLEAR, allowClear: false })
        : refuse,
      teamOfCallerDepartment: mine
        ? toOneCheck(strapi, TEAM_UID, inMine, {
            ...EXACTLY_ONE_OR_CLEAR,
            populate: { department: { select: ["id"] } },
          })
        : refuse,
      user: toOneCheck(strapi, USER_UID, undefined, EXACTLY_ONE_OR_CLEAR),
    },
    relationListChecks: {
      departments: listCheck(strapi, DEPARTMENT_UID),
      users: listCheck(strapi, USER_UID),
      callerDepartments: mine ? callerDepartments : refuseList,
    },
    roleTypesCheck: roleTypesCheck(strapi),
    mediaChecks: { ownUpload: ownUploadCheck(strapi, context) },
    frozenChecks: {
      // No document yet (a create): nothing can have votes.
      pollHasVotes: async () => (documentId ? pollHasVotes(strapi, documentId) : false),
    },
  };
}
