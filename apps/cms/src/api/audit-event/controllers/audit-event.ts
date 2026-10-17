import { factories } from "@strapi/strapi";
import {
  AUTHORING_ROLE_CLASSES,
  WIKI_EDITOR_CLASSES,
  type ActivityActorClass,
  type ActivityActorKind,
  type ActivityListQuery,
  type ActivityListResponse,
  type ActivityListRow,
} from "@sinnlos/domain";

import { ADMIN, hasRole } from "../../../bootstrap/roles";
import { AUDIT_ACTOR_KINDS, AUDIT_EVENT_UID } from "../../../utils/audit";
import { GUARDED_UIDS } from "../../../utils/authoring-uids";
import { CLASSIFIED_UID, UPLOAD_FILE_UID } from "../../../utils/delete-audit";
import { isRowId, parseRowId } from "../../../utils/entry-id";
import { isOffsetLessInstantString } from "../../../utils/offsetless-datetime-guard";
import { instantMsOrNull, toIsoZ } from "../../../utils/time";

const PAGE_SIZE = 25;
const QUERY_KEYS = ["page", "targetUid", "actorKind", "actorId", "actorClass", "from", "to"];
const TARGET_UIDS = [...GUARDED_UIDS, CLASSIFIED_UID, UPLOAD_FILE_UID];
const ACTOR_CLASSES: readonly string[] = [...AUTHORING_ROLE_CLASSES, ...WIKI_EDITOR_CLASSES];
const EVENT_FIELDS = [
  "id",
  "createdAt",
  "action",
  "targetUid",
  "targetDocumentId",
  "revision",
  "source",
  "keys",
  "detail",
  "actorKind",
  "actorUserId",
  "actorAdminId",
  "actorClass",
];

function parseQuery(raw: Record<string, unknown>): ActivityListQuery | null {
  if (Object.keys(raw).some((key) => !QUERY_KEYS.includes(key))) return null;
  const page = raw.page === undefined ? 1 : parseRowId(raw.page);
  if (page === null || page > 10_000) return null;
  if (
    raw.targetUid !== undefined &&
    (typeof raw.targetUid !== "string" || !TARGET_UIDS.includes(raw.targetUid))
  )
    return null;
  if (
    raw.actorKind !== undefined &&
    !AUDIT_ACTOR_KINDS.includes(raw.actorKind as ActivityActorKind)
  )
    return null;
  if (
    raw.actorClass !== undefined &&
    (typeof raw.actorClass !== "string" || !ACTOR_CLASSES.includes(raw.actorClass))
  )
    return null;
  const actorId = raw.actorId === undefined ? undefined : parseRowId(raw.actorId);
  if (
    actorId === null ||
    (actorId !== undefined && raw.actorKind !== "user" && raw.actorKind !== "admin")
  )
    return null;
  for (const key of ["from", "to"] as const) {
    const value = raw[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        isOffsetLessInstantString(value) ||
        instantMsOrNull(value) === null)
    )
      return null;
  }
  const query = {
    ...raw,
    page,
    ...(actorId !== undefined ? { actorId } : {}),
  } as ActivityListQuery;
  if (query.from && query.to && instantMsOrNull(query.from)! > instantMsOrNull(query.to)!)
    return null;
  return query;
}

interface StoredEvent extends Omit<ActivityListRow, "actor" | "createdAt"> {
  createdAt: string | Date;
  actorKind: ActivityActorKind;
  actorUserId: number | null;
  actorAdminId: number | null;
  actorClass: ActivityActorClass | null;
}

export default factories.createCoreController(AUDIT_EVENT_UID, ({ strapi }) => ({
  async list(ctx) {
    if (!ctx.state.user) return ctx.unauthorized();
    if (!hasRole(ctx.state.user, [ADMIN])) return ctx.forbidden();
    const query = parseQuery(ctx.query ?? {});
    if (!query) return ctx.badRequest("Invalid activity query");
    ctx.set("Cache-Control", "private, no-store");

    const where: Record<string, unknown> = {};
    if (query.targetUid) where.targetUid = query.targetUid;
    if (query.actorKind) where.actorKind = query.actorKind;
    if (query.actorClass) where.actorClass = query.actorClass;
    if (query.actorId !== undefined) {
      where[query.actorKind === "user" ? "actorUserId" : "actorAdminId"] = query.actorId;
    }
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { $gte: new Date(instantMsOrNull(query.from)!) } : {}),
        ...(query.to ? { $lte: new Date(instantMsOrNull(query.to)!) } : {}),
      };
    }
    const page = query.page!;
    const offset = (page - 1) * PAGE_SIZE;
    const events = strapi.db.query(AUDIT_EVENT_UID);
    const total = await events.count({ where });
    const rows = (total > offset
      ? await events.findMany({
          where,
          select: EVENT_FIELDS,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          offset,
          limit: PAGE_SIZE,
        })
      : []) as unknown as StoredEvent[];

    // Only the actors on this page are loaded; numeric user/admin ids are separate namespaces.
    const userIds = [
      ...new Set(
        rows
          .filter((row) => row.actorKind === "user")
          .map((row) => row.actorUserId)
          .filter(isRowId),
      ),
    ];
    const adminIds = [
      ...new Set(
        rows
          .filter((row) => row.actorKind === "admin")
          .map((row) => row.actorAdminId)
          .filter(isRowId),
      ),
    ];
    const [users, admins] = await Promise.all([
      userIds.length
        ? strapi.db.query("plugin::users-permissions.user").findMany({
            where: { id: { $in: userIds } },
            select: ["id", "displayName"],
            limit: PAGE_SIZE,
          })
        : [],
      adminIds.length
        ? strapi.db.query("admin::user").findMany({
            where: { id: { $in: adminIds } },
            select: ["id", "firstname", "lastname"],
            limit: PAGE_SIZE,
          })
        : [],
    ]);
    const userNames = new Map(
      users.map((user) => [user.id, user.displayName || `User #${user.id}`]),
    );
    const adminNames = new Map(
      admins.map((admin) => [
        admin.id,
        [admin.firstname, admin.lastname].filter(Boolean).join(" ") || `Administrator #${admin.id}`,
      ]),
    );
    const response: ActivityListResponse = {
      data: rows.map((row) => {
        const kind = row.actorKind;
        const id = kind === "user" ? row.actorUserId : kind === "admin" ? row.actorAdminId : null;
        const displayName =
          kind === "system"
            ? "System"
            : kind === "user"
              ? (userNames.get(id!) ?? (id === null ? "Unknown user" : `Deleted user #${id}`))
              : (adminNames.get(id!) ??
                (id === null ? "Unknown administrator" : `Deleted administrator #${id}`));
        return {
          id: row.id,
          createdAt: toIsoZ(row.createdAt),
          action: row.action,
          targetUid: row.targetUid,
          targetDocumentId: row.targetDocumentId,
          revision: row.revision ?? null,
          source: row.source,
          keys: Array.isArray(row.keys)
            ? row.keys.filter((key): key is string => typeof key === "string")
            : [],
          detail: typeof row.detail === "string" ? row.detail : null,
          actor: { kind, id, displayName, class: row.actorClass ?? null },
        };
      }),
      meta: {
        pagination: {
          page,
          pageSize: PAGE_SIZE,
          pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
          total,
        },
      },
    };
    return ctx.send(response);
  },
}));
