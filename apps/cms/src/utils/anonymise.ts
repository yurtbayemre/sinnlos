import {
  ANONYMISE_CODES,
  ANONYMISE_DELETED,
  ANONYMISE_KEPT,
  NOTIFICATION_TITLES,
  formerPersonLabel,
  type AnonymiseCounts,
  type AnonymiseDeletedClass,
  type AnonymiseKeptClass,
  type AnonymisePreviewResponse,
  type AnonymiseResponse,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { digestDefaultLocale } from "../digest/render-digest";
import { recordAuditEvent, type AuditHost } from "./audit";
import { runWithDeleteAudit } from "./delete-audit";
import { lockUserRow, type MfaHost } from "./mfa-core";
import { NOTIFICATION_UID, buildNotification, type NotificationType } from "./notify";
import { refuse } from "./refusal";
import { fillMissingSnapshots, publicationStamp } from "./training-evidence";
import { removeReserved, reserveRemoval } from "./upload-orphans";
import { assertActiveAdmin, lockDirectory, type UserAdminHost } from "./user-admin";

/**
 * The anonymisation of one person (GDPR Art. 17; v0.28, deep-dive
 * plan-v028-rev2.md §4 with rev3 R3-R5 and rev3.1; owner decisions of
 * 2026-10-23): POST /api/user-management/:id/anonymise, admin_role only,
 * after a preview (GET, counts only).
 *
 * PRECONDITION: the person is blocked (an earlier, separate admin step,
 * which raised their token version and ended their sessions). Already
 * anonymised: 409 `anonymised`; not blocked: 409 `notBlocked`; `confirm`
 * not their current username: 400 `confirm`. The last-admin rule holds by
 * the existing invariant: the caller is a freshly locked active admin, the
 * target is blocked.
 *
 * ONE TRANSACTION, lock order directory → caller → target (as every user
 * administration write, utils/user-admin.ts), re-checked under the locks:
 *   1. the person's receipts without a snapshot get one now
 *      (fillMissingSnapshots), while their name is still there;
 *   2. deleted (deletePersonalRows): reactions, all their poll votes (no
 *      duplicate ballot can stay behind), RSVPs, kudos addressed to them,
 *      all their notifications (anchors too: new fan-outs skip blocked
 *      recipients), their read confirmations (owner decision), their ads
 *      through the Document Service (its lifecycle records the delete and
 *      removes the images after the commit);
 *   3. other people's notifications naming them as actor lose the name
 *      (rewriteActorNotifications): the actor link and `titleParams.actor`
 *      go, the stored English title is rendered again, so the bell and the
 *      digest show the template's own neutral word ("Someone" / "Jemand")
 *      in each reader's language; subject, link, recipient, read state and
 *      anchors stay. Rows from before AC04 (no titleParams) lose only the
 *      link: their stored title stays (documented);
 *   4. the row: username `former-<documentId>`, e-mail
 *      `former-<documentId>@anonymised.invalid` (documentIds are unique; a
 *      unique violation fails the whole run and overwrites nothing), the
 *      display name "Ehemalige Person" / "Former person"
 *      (DIGEST_DEFAULT_LOCALE), every profile field, the password, tokens
 *      and the second factor cleared, the avatar unlinked, `anonymisedAt`.
 *      KEPT on purpose: the identity-provider ids (an SSO sign-in finds the
 *      blocked row and is refused before any profile sync, instead of
 *      provisioning a new account), the role, and the organisation links
 *      (department, teams, manager, head/lead): the directory hides blocked
 *      people, and no department or team write is needed;
 *   5. one `anonymise` audit row: the deleted counts and the avatar file id,
 *      no names.
 * Business content (announcements, wiki, documents, events, polls,
 * comments, kudos they gave, duty plans, KPIs) stays with the neutral name;
 * training receipts stay under their retention (utils/training-evidence.ts).
 *
 * AFTER THE COMMIT the avatar file goes through one removal reservation
 * that refuses a file anything links (reserveRemoval + removeReserved; the
 * stamp rule of the app's removers is left out for this known file). A
 * linked file, or a failure, keeps it: the answer says so, the audit row
 * holds its id, and the admin deletes it in the Media Library.
 *
 * THE ERASURE SWEEP (sweepAnonymised, nightly) repeats steps 2 (without the
 * ads) and 3 for every anonymised person: a fan-out batch or a comment
 * callback that read the person before the commit and wrote after it is
 * gone by the next night (rev3 R3, rev3.1).
 *
 * The anonymisation and the sweep run whatever FEATURES_OFF says.
 */

const USER_UID = "plugin::users-permissions.user";
const CLASSIFIED_UID = "api::classified.classified";
const ID_PAGE = 500;

type Row = Record<string, unknown>;

/** The slice of the Strapi instance this module uses. */
export interface AnonymiseHost extends Omit<UserAdminHost, "db"> {
  db: Omit<UserAdminHost["db"], "query"> & {
    query(uid: string): {
      findOne(params: Row): Promise<unknown>;
      findMany(params: Row): Promise<unknown>;
      count(params: Row): Promise<number>;
      update(params: Row): Promise<unknown>;
      create(params: { data: Row }): Promise<unknown>;
      deleteMany(params: Row): Promise<unknown>;
    };
  };
  documents(uid: string): { delete(params: { documentId: string }): Promise<unknown> };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The rows the anonymisation deletes, by class: type and the relation naming the person. */
const DELETED_BY_RELATION: Readonly<
  Record<Exclude<AnonymiseDeletedClass, "classifieds">, { uid: string; field: string }>
> = {
  reactions: { uid: "api::reaction.reaction", field: "author" },
  pollVotes: { uid: "api::poll-vote.poll-vote", field: "voter" },
  rsvps: { uid: "api::event-rsvp.event-rsvp", field: "user" },
  kudosReceived: { uid: "api::kudos.kudos", field: "to" },
  notifications: { uid: NOTIFICATION_UID, field: "recipient" },
  acknowledgements: { uid: "api::acknowledgement.acknowledgement", field: "user" },
};

/** The classes that stay, counted for the preview (documents: their draft rows, one per document). */
const KEPT_BY_RELATION: Readonly<
  Record<AnonymiseKeptClass, { uid: string; field: string; documents?: boolean }>
> = {
  announcements: { uid: "api::announcement.announcement", field: "author", documents: true },
  wikiPages: { uid: "api::wiki-page.wiki-page", field: "author", documents: true },
  documents: { uid: "api::document.document", field: "uploadedBy", documents: true },
  events: { uid: "api::event.event", field: "organizer", documents: true },
  polls: { uid: "api::poll.poll", field: "author", documents: true },
  comments: { uid: "api::comment.comment", field: "author" },
  kudosGiven: { uid: "api::kudos.kudos", field: "from" },
  dutyPlans: { uid: "api::duty-plan.duty-plan", field: "author", documents: true },
  kpis: { uid: "api::kpi.kpi", field: "author", documents: true },
  trainingReceipts: { uid: "api::lesson-progress.lesson-progress", field: "user" },
};

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

/** Other people's notifications naming the person as their actor. */
const namingWhere = (id: number): Row => ({ actor: { id } });

async function countAll(strapi: AnonymiseHost, id: number): Promise<AnonymiseCounts> {
  const deleted = zeroes(ANONYMISE_DELETED);
  for (const [key, { uid, field }] of Object.entries(DELETED_BY_RELATION)) {
    deleted[key as AnonymiseDeletedClass] = await strapi.db
      .query(uid)
      .count({ where: { [field]: { id } } });
  }
  deleted.classifieds = await strapi.db.query(CLASSIFIED_UID).count({ where: { author: { id } } });
  const kept = zeroes(ANONYMISE_KEPT);
  for (const [key, { uid, field, documents }] of Object.entries(KEPT_BY_RELATION)) {
    kept[key as AnonymiseKeptClass] = await strapi.db.query(uid).count({
      where: documents ? { [field]: { id }, publishedAt: { $null: true } } : { [field]: { id } },
    });
  }
  // Their own notifications (also deleted) are not rewritten.
  const notifications =
    (await strapi.db.query(NOTIFICATION_UID).count({ where: namingWhere(id) })) -
    (await strapi.db
      .query(NOTIFICATION_UID)
      .count({ where: { ...namingWhere(id), recipient: { id } } }));
  return { deleted, rewritten: { notifications }, kept };
}

/** Ids of `uid` rows whose `field` links the person, all pages. */
async function idsLinking(strapi: AnonymiseHost, uid: string, where: Row): Promise<number[]> {
  const ids: number[] = [];
  let afterId = 0;
  for (;;) {
    const page = rows(
      await strapi.db.query(uid).findMany({
        where: { $and: [where, { id: { $gt: afterId } }] },
        select: ["id"],
        orderBy: [{ id: "asc" }],
        limit: ID_PAGE,
      }),
    );
    if (page.length === 0) return ids;
    for (const row of page) ids.push(row.id as number);
    afterId = page[page.length - 1].id as number;
  }
}

/**
 * Step 2 (see the module comment). `withClassifieds`: the run deletes the
 * ads too, the nightly sweep does not. The link rows go with each row
 * (ON DELETE CASCADE, as prune-notifications.ts relies on).
 */
export async function deletePersonalRows(
  strapi: AnonymiseHost,
  id: number,
  withClassifieds: boolean,
): Promise<Record<AnonymiseDeletedClass, number>> {
  const deleted = zeroes(ANONYMISE_DELETED);
  for (const [key, { uid, field }] of Object.entries(DELETED_BY_RELATION)) {
    const ids = await idsLinking(strapi, uid, { [field]: { id } });
    for (let start = 0; start < ids.length; start += ID_PAGE) {
      await strapi.db
        .query(uid)
        .deleteMany({ where: { id: { $in: ids.slice(start, start + ID_PAGE) } } });
    }
    deleted[key as AnonymiseDeletedClass] = ids.length;
  }
  if (withClassifieds) {
    const ads = rows(
      await strapi.db.query(CLASSIFIED_UID).findMany({
        where: { author: { id } },
        select: ["id", "documentId"],
        orderBy: [{ id: "asc" }],
      }),
    );
    for (const ad of ads) {
      const documentId = text(ad.documentId);
      if (documentId) await strapi.documents(CLASSIFIED_UID).delete({ documentId });
    }
    deleted.classifieds = ads.length;
  }
  return deleted;
}

/** Step 3 (see the module comment); returns the rows rewritten. */
export async function rewriteActorNotifications(
  strapi: AnonymiseHost,
  id: number,
): Promise<number> {
  const ids = await idsLinking(strapi, NOTIFICATION_UID, namingWhere(id));
  let rewritten = 0;
  for (const notificationId of ids) {
    const row = await strapi.db.query(NOTIFICATION_UID).findOne({
      where: { id: notificationId },
      select: ["id", "type", "titleParams", "link"],
    });
    if (!isRecord(row)) continue;
    const data: Row = { actor: null };
    const type = text(row.type);
    if (
      isRecord(row.titleParams) &&
      type &&
      Object.prototype.hasOwnProperty.call(NOTIFICATION_TITLES.en, type)
    ) {
      const { actor: _actor, ...params } = row.titleParams;
      const rebuilt = buildNotification({
        type: type as NotificationType,
        titleParams: params,
        link: text(row.link) ?? "",
        recipient: 0,
      });
      data.titleParams = rebuilt.titleParams;
      data.title = rebuilt.title;
    }
    await strapi.db.query(NOTIFICATION_UID).update({ where: { id: notificationId }, data });
    rewritten++;
  }
  return rewritten;
}

/** GET /api/user-management/:id/anonymise: what a run would do now (advisory). */
export async function anonymisePreview(
  strapi: AnonymiseHost,
  id: number,
): Promise<AnonymisePreviewResponse["data"]> {
  const user = await strapi.db.query(USER_UID).findOne({
    where: { id },
    select: ["id", "username", "displayName", "blocked", "anonymisedAt"],
  });
  if (!isRecord(user)) throw new errors.NotFoundError("Not Found");
  return {
    id,
    username: text(user.username) ?? "",
    displayName: text(user.displayName) || text(user.username) || "",
    blocked: user.blocked === true,
    anonymisedAt: publicationStamp(user.anonymisedAt),
    counts: await countAll(strapi, id),
  };
}

/** The row's new values (step 4). */
function tombstoneData(documentId: string, at: Date, avatarUnlinked: boolean): Row {
  return {
    username: `former-${documentId}`,
    email: `former-${documentId}@anonymised.invalid`,
    displayName: formerPersonLabel(digestDefaultLocale()),
    jobTitle: null,
    phone: null,
    officeLocation: null,
    hireDate: null,
    birthday: null,
    birthdayVisible: false,
    locale: null,
    digestAnnouncements: false,
    digestMentions: false,
    digestKudos: false,
    password: null,
    resetPasswordToken: null,
    confirmationToken: null,
    totpSecret: null,
    totpEnabledAt: null,
    totpLastStep: null,
    totpRecoveryCodes: null,
    ...(avatarUnlinked ? { avatar: null } : {}),
    anonymisedAt: at.toISOString(),
  };
}

const auditDetail = (deleted: Record<string, number>, rewritten: number, avatarId: number | null) =>
  [
    ...Object.entries(deleted)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}:${count}`),
    rewritten > 0 ? `rewrittenNotifications:${rewritten}` : null,
    avatarId !== null ? `avatarFile:${avatarId}` : null,
  ]
    .filter(Boolean)
    .join(" ") || "nothing to delete";

/** POST /api/user-management/:id/anonymise (see the module comment). */
export async function anonymiseUser(
  strapi: AnonymiseHost,
  callerId: number,
  callerTv: number | undefined,
  id: number,
  confirm: unknown,
): Promise<AnonymiseResponse["data"]> {
  let avatarId: number | null = null;
  let documentId = "";
  const at = new Date();
  const counts = await strapi.db.transaction(async ({ trx }) => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, trx, callerId, callerTv);
    await lockUserRow(strapi as unknown as MfaHost, trx, id);
    const user = await strapi.db.query(USER_UID).findOne({
      where: { id },
      select: ["id", "documentId", "username", "blocked", "anonymisedAt"],
      populate: { avatar: { select: ["id"] } },
    });
    if (!isRecord(user)) throw new errors.NotFoundError("Not Found");
    if (user.anonymisedAt != null) refuse(409, ANONYMISE_CODES.anonymised, "Already anonymised");
    if (user.blocked !== true) refuse(409, ANONYMISE_CODES.notBlocked, "Block the person first");
    if (typeof confirm !== "string" || confirm !== user.username) {
      refuse(400, ANONYMISE_CODES.confirm, "confirm must be the person's username");
    }
    documentId = text(user.documentId) ?? String(id);
    avatarId = isRecord(user.avatar) && typeof user.avatar.id === "number" ? user.avatar.id : null;

    await fillMissingSnapshots(strapi as never, { userId: id });
    const before = await countAll(strapi, id);
    const deleted = await deletePersonalRows(strapi, id, true);
    const rewritten = await rewriteActorNotifications(strapi, id);
    await strapi.db
      .query(USER_UID)
      .update({ where: { id }, data: tombstoneData(documentId, at, avatarId !== null) });
    await recordAuditEvent(strapi as unknown as AuditHost, {
      action: "anonymise",
      targetUid: USER_UID,
      targetDocumentId: documentId,
      actorKind: "user",
      actorUserId: callerId,
      actorClass: "moderator",
      source: "content-api",
      detail: auditDetail(deleted, rewritten, avatarId),
    });
    return { deleted, rewritten: { notifications: rewritten }, kept: before.kept };
  });
  strapi.log.info(`[anonymise] user=${documentId} anonymised by user=${callerId}`);
  const avatar =
    avatarId === null
      ? null
      : { id: avatarId, removed: await removeAvatar(strapi, avatarId, documentId) };
  return { id, anonymisedAt: at.toISOString(), counts, avatar };
}

/** The avatar's removal after the commit (see the module comment); never throws. */
async function removeAvatar(
  strapi: AnonymiseHost,
  fileId: number,
  documentId: string,
): Promise<boolean> {
  try {
    return await runWithDeleteAudit({ related: { uid: USER_UID, documentId } }, async () => {
      const reserved = await reserveRemoval(strapi, fileId, (_file, linked) =>
        linked ? "linked" : "claim",
      );
      if (!("file" in reserved)) return reserved.outcome === "missing";
      return (await removeReserved(strapi, fileId)) !== "linked";
    });
  } catch (err) {
    strapi.log.error(
      `[anonymise] user=${documentId}: avatar file ${fileId} not removed (${(err as Error).message}); delete it in the Media Library`,
    );
    return false;
  }
}

/**
 * The nightly erasure sweep (see the module comment): every anonymised
 * person, each in its own transaction. Returns the rows it removed and
 * rewrote.
 */
export async function sweepAnonymised(
  strapi: AnonymiseHost,
): Promise<{ deleted: number; rewritten: number }> {
  let deleted = 0;
  let rewritten = 0;
  const people = await idsLinking(strapi, USER_UID, { anonymisedAt: { $notNull: true } });
  for (const id of people) {
    await strapi.db.transaction(async () => {
      const removed = await deletePersonalRows(strapi, id, false);
      deleted += Object.values(removed).reduce((sum, count) => sum + count, 0);
      rewritten += await rewriteActorNotifications(strapi, id);
    });
  }
  strapi.log.info(
    `[erasure-sweep] ${people.length} anonymised account(s): removed ${deleted} row(s), rewrote ${rewritten} notification(s)`,
  );
  return { deleted, rewritten };
}
