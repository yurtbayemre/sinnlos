import {
  createUserWriteGuard,
  type TokenVersionStrapi,
} from "../extensions/users-permissions/strapi-server";
import { createDepartmentAudienceGuard } from "../utils/department-audience-guard";
import { createDocumentLock, type DocumentLockMiddlewareHost } from "../utils/document-lock";
import { createOffsetlessDatetimeGuard } from "../utils/offsetless-datetime-guard";
import {
  createPollAudienceGuard,
  type DocumentMiddleware,
  type PollAudienceGuardHost,
} from "../utils/poll-audience-guard";
import { createPublishReadiness, type PublishReadinessHost } from "../utils/publish-readiness";
import { createScheduleClear, type ScheduleClearHost } from "../utils/schedule";

/**
 * Every Document Service middleware of the app, registered in one place and
 * in one order (decision 06 §K; batch 15 plan S1, contract K6).
 *
 * @strapi/core runs the middlewares in registration order around every
 * Document Service action, the first registered outermost, after its own
 * databaseErrorsMiddleware (document-service/middlewares/middleware-
 * manager.js: `use` pushes, `run` chains by index; C4,
 * framework-contract.test.ts). Every writer goes through them: the content
 * API, the Content Manager (single and bulk, C19), the scheduler, the demo
 * seed and the draft-twin repair. The slots, outermost first:
 *
 *   1. offset-less datetime guard (§F): 400 before any transaction;
 *   2. document lock (§G): opens the transaction, locks and compares the
 *      revision, advances it after the action;
 *   3a. poll guard (`createPollAudienceGuard`): the poll audience flag, and
 *      from 15A the vote freeze under the poll's lock;
 *   3b. department/targeting guard (`createDepartmentAudienceGuard`): the
 *      document and quick-link flag, and from 15D the announcement and
 *      event targeting flags;
 *   4. (batch 16B: the wiki checks);
 *   5. schedule-clear (§D rule 6);
 *   6. publish readiness (§G2);
 *   7. (batch 16B: the media claims);
 *   8. audit recorder (§H): last of the content middlewares, inside the
 *      transaction;
 *   9. the FX40 user write guard: users are neither locked nor audited, so
 *      its position carries no load; last.
 *
 * The guards open their own `strapi.db.transaction`, which joins the lock's
 * (C5/C8). The factory names and signatures of 3a and 3b are frozen (K6):
 * 15A and 15D change only what the returned middleware does.
 *
 * Registered in register(), before any plugin or bootstrap code writes a
 * row. Without `strapi.documents.use` (a Strapi upgrade moved it) the boot
 * fails: the cms must not run without its guards.
 */

export const DOCUMENT_MIDDLEWARES_LOG = "[document-middlewares]";

/** The slot names in registration (= run) order, including the reserved ones. */
export const DOCUMENT_MIDDLEWARE_SLOTS = [
  "offsetless-datetime-guard",
  "document-lock",
  "poll-audience-guard",
  "department-audience-guard",
  "wiki-checks",
  "schedule-clear",
  "publish-readiness",
  "media-claims",
  "audit-recorder",
  "user-write-guard",
] as const;

export type DocumentMiddlewareSlot = (typeof DOCUMENT_MIDDLEWARE_SLOTS)[number];

/** The slice of the Strapi instance the middlewares use. */
export type DocumentMiddlewaresHost = PollAudienceGuardHost &
  TokenVersionStrapi &
  DocumentLockMiddlewareHost &
  ScheduleClearHost &
  PublishReadinessHost;

/** register() also needs `strapi.documents.use`. */
export type DocumentMiddlewaresRegistrationHost = DocumentMiddlewaresHost & {
  documents?: { use?: (middleware: DocumentMiddleware) => unknown } | null;
};

/** One registered middleware and its slot. */
export interface SlottedMiddleware {
  slot: DocumentMiddlewareSlot;
  middleware: DocumentMiddleware;
}

/**
 * The middlewares in slot order. Reserved slots (a later batch's) and slots
 * whose module is not wired yet are absent.
 */
export function documentMiddlewares(strapi: DocumentMiddlewaresHost): SlottedMiddleware[] {
  const slotted: SlottedMiddleware[] = [
    { slot: "offsetless-datetime-guard", middleware: createOffsetlessDatetimeGuard() },
    { slot: "document-lock", middleware: createDocumentLock(strapi) },
    { slot: "poll-audience-guard", middleware: createPollAudienceGuard(strapi) },
    { slot: "department-audience-guard", middleware: createDepartmentAudienceGuard(strapi) },
    { slot: "schedule-clear", middleware: createScheduleClear(strapi) },
    { slot: "publish-readiness", middleware: createPublishReadiness(strapi) },
    { slot: "user-write-guard", middleware: createUserWriteGuard(strapi) },
  ];
  return slotted.sort(
    (a, b) => DOCUMENT_MIDDLEWARE_SLOTS.indexOf(a.slot) - DOCUMENT_MIDDLEWARE_SLOTS.indexOf(b.slot),
  );
}

/**
 * Hangs every middleware onto the Document Service in slot order, or throws
 * before registering any when the Document Service has no `use`.
 */
export function registerDocumentMiddlewares(strapi: DocumentMiddlewaresRegistrationHost): void {
  const documents = strapi.documents;
  if (!documents || typeof documents.use !== "function") {
    throw new Error(
      `${DOCUMENT_MIDDLEWARES_LOG} strapi.documents.use not found — refusing to boot without the ` +
        "Document Service middlewares (datetime guard, document lock, audience guards, schedule, " +
        "readiness, audit, user write guard)",
    );
  }
  for (const { middleware } of documentMiddlewares(strapi)) documents.use(middleware);
}
