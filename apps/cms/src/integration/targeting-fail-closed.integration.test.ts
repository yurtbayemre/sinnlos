import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";

import {
  ADMIN_ENV,
  contentManager,
  createUser,
  signIn,
  type ContentManager,
} from "./admin-api.test.helper";
import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Params,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import {
  holdTransaction,
  qualified,
  settle,
  testSchema,
  waitForLockWait,
  type Settled,
} from "./pg-lock.test.helper";

/**
 * Department targeting fails closed, on the real stack (batch 15 lane 15D;
 * decision 06 §B6, §D rule 13, §N9, §N10; amendment rows A2, A3, A5):
 *   - D-PT01: an announcement whose audience is "departments" without a
 *     department or a team is for moderators only, and notifies nobody;
 *   - a department deleted in the admin panel marks the announcements that
 *     targeted it (`retargetRequired`), flags the events that linked it
 *     (`notifyAudience`), and advances the revisions of every
 *     announcement, event and document that linked it;
 *   - department plus team (A3): deleting either criterion makes the
 *     announcement moderator-only, so neither the team's members in other
 *     departments nor the rest of the department read it;
 *   - an event restricted to departments without one notifies nobody on a
 *     republish;
 *   - the thread of a restricted announcement answers like a missing
 *     target;
 *   - the boot backfill (lane 15B) restores a legacy row's flag, so an
 *     unlink and republish notifies nobody; and its twin rule restores a
 *     flag or marker the batch-14 image's "Discard changes" lost, so the
 *     roll-forward's republish keeps the item restricted;
 *   - on Postgres, a link committed while the delete runs is marked too,
 *     and the four read-only diagnostics list exactly the seeded rows.
 * Writes go through the Document Service in-process and the admin panel's
 * Content Manager; reads over HTTP as the users they concern.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const DOCUMENT = "api::document.document";
const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const USER = "plugin::users-permissions.user";
const NOTIFICATION = "api::notification.notification";
const VERSION = "api::content-version.content-version";

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

type FlagRow = Row & { id: number; audience?: string | null; retargetRequired?: boolean | null };

/** The read-side helpers of utils/visible-ids.ts and the shared predicate. */
interface VisibleIds {
  withFreshAnnouncementFlags(
    strapi: unknown,
    rows: FlagRow[],
    where: Record<string, unknown>,
  ): Promise<FlagRow[]>;
  loadUserScope(strapi: unknown, userId: number): Promise<unknown>;
  loadAllUserScopes(strapi: unknown): Promise<Array<{ userId: number }>>;
  loadRoleGrants(
    strapi: unknown,
    actions: readonly string[],
  ): Promise<{ holders(action: string): ReadonlySet<number> }>;
  toAudienceScope(scope: unknown): unknown;
  announcementRecipients(
    announcement: FlagRow,
    scopes: Array<{ userId: number }>,
    readers: ReadonlySet<number>,
  ): Array<{ userId: number }>;
}
interface AnnouncementAudience {
  isAnnouncementVisible(announcement: FlagRow, scope: unknown): boolean;
}

const START = "2027-03-01T09:00:00.000Z";

/** One of infra/diagnostics/*.sql, as the owner pipes it into psql. */
const diagnostic = (file: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "..", "infra", "diagnostics", file), "utf8");

interface PgResult {
  command: string;
  rows: Array<Record<string, unknown>>;
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}

describe.each(testEngines())("targeting fails closed on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  let salesMember: Caller;
  let salesMemberId: number;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
    const sales = await createUser(t, "member", t.fixtures.departments.sales);
    salesMemberId = sales.id;
    salesMember = { jwt: await signIn(t, sales) };
  });

  afterAll(async () => {
    await t?.stop();
  });

  // ---------------------------------------------------------------------------
  // helpers

  const settleFanouts = () => t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();

  /** The ids of the users notified of `documentId`, ascending. */
  const notified = async (documentId: string) => {
    await settleFanouts();
    const rows = await t.strapi.db.query(NOTIFICATION).findMany({
      where: { sourceDocumentId: documentId },
      populate: { recipient: { select: ["id"] } },
    });
    return rows
      .map((row) => (row.recipient as { id: number } | null)?.id)
      .filter((id): id is number => typeof id === "number")
      .sort((a, b) => a - b);
  };

  const department = (name: string) =>
    t.strapi.documents(DEPARTMENT).create({
      data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") },
    });

  const team = (name: string, of: Row) =>
    t.strapi.documents(TEAM).create({
      data: {
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        department: of.documentId,
      },
    });

  /** A member of `of` (and of `teams`), with a JWT. */
  const member = async (of: Row | null, teams: Row[] = [], role: TestRole = "member") => {
    const user = await createUser(t, role, of);
    if (teams.length > 0) {
      await t.strapi.db
        .query(USER)
        .update({ where: { id: user.id }, data: { teams: teams.map((row) => row.id) } });
    }
    return { id: user.id, caller: { jwt: await signIn(t, user) } as Caller };
  };

  const publish = (uid: string, data: Params) =>
    t.strapi.documents(uid).create({ data, status: "published" });

  /** GET of one announcement: the status the caller gets. */
  const readStatus = async (caller: Caller, documentId: string) =>
    (await t.api(caller, `/api/announcements/${documentId}`)).status;

  /** The stored [published?, audience, retargetRequired] of each row, draft first. */
  const announcementFlags = async (documentId: string) =>
    (
      await t.strapi.db.query(ANNOUNCEMENT).findMany({
        where: { documentId },
        select: ["audience", "retargetRequired", "publishedAt"],
      })
    )
      .map((row) => [row.publishedAt != null, row.audience, row.retargetRequired === true])
      .sort((a, b) => Number(a[0]) - Number(b[0]));

  const eventFlags = async (documentId: string) =>
    (
      await t.strapi.db.query(EVENT).findMany({
        where: { documentId },
        select: ["notifyAudience", "publishedAt"],
      })
    )
      .map((row) => [row.publishedAt != null, row.notifyAudience])
      .sort((a, b) => Number(a[0]) - Number(b[0]));

  /** The document's revision (content_versions; 0 without a row). */
  const revision = async (uid: string, documentId: string) => {
    const row = await t.strapi.db.query(VERSION).findOne({
      where: { targetUid: uid, targetDocumentId: documentId },
      select: ["revision"],
    });
    return Number(row?.revision ?? 0);
  };

  const comment = (caller: Caller, targetDocumentId: string) =>
    t.api(caller, "/api/comments", {
      json: { data: { body: "a word", targetType: "announcement", targetDocumentId } },
    });

  // ---------------------------------------------------------------------------

  it("D-PT01: a legacy 'departments' announcement without a target is moderator-only and notifies nobody", async () => {
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC legacy no target",
      audience: "departments",
    });
    for (const caller of ["member", "team_lead", salesMember] as Caller[]) {
      expect(await readStatus(caller, created.documentId), String(caller)).toBe(404);
    }
    for (const moderator of ["editor", "admin_role"] as const) {
      expect(await readStatus(moderator, created.documentId), moderator).toBe(200);
    }
    const list = await t.api<{ data: { documentId: string }[] }>(
      "member",
      "/api/announcements?pagination[pageSize]=100",
    );
    expect(list.body.data.map((row) => row.documentId)).not.toContain(created.documentId);
    expect(await notified(created.documentId)).toEqual([]);
    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: created.documentId });
    expect(await notified(created.documentId)).toEqual([]);
  });

  it("D-PT01: unlinking the department in the admin panel keeps the announcement restricted", async () => {
    const unit = await department("FC Unlink Dept");
    const insider = await member(unit);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC unlink",
      audience: "all",
      department: unit.documentId,
    });
    // The guard raised the flag on both rows at create.
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", false],
      [true, "departments", false],
    ]);
    expect(await notified(created.documentId)).toEqual([insider.id]);
    expect(await readStatus(insider.caller, created.documentId)).toBe(200);

    const res = await panel.publish(ANNOUNCEMENT, created.documentId, { department: null });
    expect(res.status, res.text).toBe(200);
    // Before batch 15 the published row was company-wide now: every member,
    // Sales included, read it and was notified of the republish.
    for (const caller of [insider.caller, salesMember, "member"] as Caller[]) {
      expect(await readStatus(caller, created.documentId), String(caller)).toBe(404);
    }
    expect(await readStatus("editor", created.documentId)).toBe(200);
    expect(await notified(created.documentId)).toEqual([insider.id]);
  });

  it("a department deleted in the admin panel: announcements marked, events flagged, revisions advanced", async () => {
    const unit = await department("FC Deleted Dept");
    const insider = await member(unit);
    const announcement = await publish(ANNOUNCEMENT, {
      title: "IT FC dept announcement",
      department: unit.documentId,
    });
    const owned = await publish(ANNOUNCEMENT, {
      title: "IT FC owned announcement",
      department: t.fixtures.departments.sales.documentId,
      ownerDepartment: unit.documentId,
    });
    const event = await publish(EVENT, {
      title: "IT FC dept event",
      start: START,
      departments: [unit.documentId],
    });
    const document = await publish(DOCUMENT, {
      title: "IT FC dept document",
      departments: [unit.documentId],
      ownerDepartment: unit.documentId,
    });
    expect(await notified(event.documentId)).toEqual([insider.id]);
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    const targets = [
      [ANNOUNCEMENT, announcement.documentId],
      [ANNOUNCEMENT, owned.documentId],
      [EVENT, event.documentId],
      [DOCUMENT, document.documentId],
    ] as const;
    const before = await Promise.all(targets.map(([uid, id]) => revision(uid, id)));

    const res = await panel.delete(DEPARTMENT, unit.documentId);
    expect(res.status, res.text).toBe(200);

    expect(await announcementFlags(announcement.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    // Owned only, targeting Sales: no marker, the Sales audience stays.
    expect(await announcementFlags(owned.documentId)).toEqual([
      [false, "departments", false],
      [true, "departments", false],
    ]);
    expect(await readStatus(salesMember, owned.documentId)).toBe(200);
    for (const caller of [insider.caller, salesMember, "member"] as Caller[]) {
      expect(await readStatus(caller, announcement.documentId), String(caller)).toBe(404);
    }
    expect(await readStatus("editor", announcement.documentId)).toBe(200);
    expect(await readStatus("admin_role", announcement.documentId)).toBe(200);

    // The event lost its only department: its republish notifies nobody
    // (before batch 15: the whole company).
    await t.strapi.documents(EVENT).publish({ documentId: event.documentId });
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    expect(await notified(event.documentId)).toEqual([insider.id]);
    expect(await notified(event.documentId)).not.toContain(salesMemberId);

    const after = await Promise.all(targets.map(([uid, id]) => revision(uid, id)));
    // The republish of the event advanced its revision once more when the
    // document lock runs (lane 15B); the delete advanced every one by one.
    expect(after[0]).toBe(before[0] + 1);
    expect(after[1]).toBe(before[1] + 1);
    expect(after[3]).toBe(before[3] + 1);
    expect(after[2]).toBeGreaterThanOrEqual(before[2] + 1);
  });

  it("department plus team (A3): deleting the team keeps the rest of the department out", async () => {
    const unit = await department("FC Team Del Dept");
    const squad = await team("FC Team Del Squad", unit);
    const inSquad = await member(unit, [squad]);
    const departmentOnly = await member(unit);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC dept and team, team deleted",
      department: unit.documentId,
      team: squad.documentId,
    });
    expect(await notified(created.documentId)).toEqual([inSquad.id]);
    expect(await readStatus(departmentOnly.caller, created.documentId)).toBe(404);
    const before = await revision(ANNOUNCEMENT, created.documentId);

    const res = await panel.delete(TEAM, squad.documentId);
    expect(res.status, res.text).toBe(200);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    // Without the marker the team criterion is gone and the whole
    // department would read it.
    for (const caller of [departmentOnly.caller, inSquad.caller]) {
      expect(await readStatus(caller, created.documentId)).toBe(404);
    }
    expect(await readStatus("editor", created.documentId)).toBe(200);
    expect(await revision(ANNOUNCEMENT, created.documentId)).toBe(before + 1);

    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: created.documentId });
    expect(await notified(created.documentId)).toEqual([inSquad.id]);
  });

  it.each(["unpublish", "republish"] as const)(
    "a team delete between the scalar and the relation reads, then the %s before the re-read: fails closed (Codex review)",
    async (between) => {
      const ids = t.requireBuilt<VisibleIds>("src/utils/visible-ids");
      const { isAnnouncementVisible } = t.requireBuilt<AnnouncementAudience>(
        "src/utils/announcement-audience",
      );
      const unit = await department(`FC Torn ${between} Dept`);
      const squad = await team(`FC Torn ${between} Squad`, unit);
      const inSquad = await member(unit, [squad]);
      const departmentOnly = await member(unit);
      const created = await publish(ANNOUNCEMENT, {
        title: `IT FC torn read, ${between}`,
        department: unit.documentId,
        team: squad.documentId,
      });
      expect(await notified(created.documentId)).toEqual([inSquad.id]);

      // The engine's two statements of one read, with the delete between:
      // the scalars before it (marker false) ...
      const scalars = (await t.strapi.db.query(ANNOUNCEMENT).findOne({
        where: { documentId: created.documentId, publishedAt: { $notNull: true } },
        select: ["id", "audience", "retargetRequired"],
      })) as FlagRow;
      expect(scalars.retargetRequired).not.toBe(true);
      const res = await panel.delete(TEAM, squad.documentId);
      expect(res.status, res.text).toBe(200);
      // ... the relations after it (the team gone, the department left).
      const relations = (await t.strapi.db.query(ANNOUNCEMENT).findOne({
        where: { id: scalars.id },
        select: ["id"],
        populate: {
          department: { select: ["id"] },
          team: { select: ["id"] },
          audienceRoles: { select: ["id"] },
        },
      })) as Row;
      expect(relations.team ?? null).toBeNull();
      const torn: FlagRow = {
        ...scalars,
        department: relations.department,
        team: relations.team ?? null,
        audienceRoles: relations.audienceRoles,
      };
      const scope = ids.toAudienceScope(await ids.loadUserScope(t.strapi, departmentOnly.id));
      // Taken as it is, the torn row admits the rest of the department.
      expect(isAnnouncementVisible(torn, scope)).toBe(true);

      // The published row is gone (unpublish) or replaced (republish: a new
      // row id) before the flags are read again.
      if (between === "unpublish") {
        await t.strapi.documents(ANNOUNCEMENT).unpublish({ documentId: created.documentId });
      } else {
        await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: created.documentId });
      }
      const [checked] = await ids.withFreshAnnouncementFlags(t.strapi, [torn], { id: torn.id });
      expect(checked.retargetRequired).toBe(true);
      expect(isAnnouncementVisible(checked, scope)).toBe(false);
      // The fan-out's audience of that row: nobody (the announcement
      // lifecycle reads it this way, utils/visible-ids.ts).
      const grants = await ids.loadRoleGrants(t.strapi, [`${ANNOUNCEMENT}.find`]);
      const recipients = ids.announcementRecipients(
        checked,
        await ids.loadAllUserScopes(t.strapi),
        grants.holders(`${ANNOUNCEMENT}.find`),
      );
      expect(recipients.map((recipient) => recipient.userId)).toEqual([]);
      // And nobody got the announcement but the team member of the first publish.
      expect(await notified(created.documentId)).toEqual([inSquad.id]);
      expect(await readStatus(departmentOnly.caller, created.documentId)).toBe(404);
    },
  );

  it("department plus team (A3): deleting the department keeps the team's outsiders out", async () => {
    const unit = await department("FC Dept Del Dept");
    const squad = await team("FC Dept Del Squad", unit);
    const inSquad = await member(unit, [squad]);
    const outsider = await member(t.fixtures.departments.sales, [squad]);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC dept and team, dept deleted",
      department: unit.documentId,
      team: squad.documentId,
    });
    expect(await notified(created.documentId)).toEqual([inSquad.id]);
    expect(await readStatus(outsider.caller, created.documentId)).toBe(404);

    const res = await panel.delete(DEPARTMENT, unit.documentId);
    expect(res.status, res.text).toBe(200);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    // The team survives the department delete; without the marker its Sales
    // member would read the announcement now.
    expect(await readStatus(outsider.caller, created.documentId)).toBe(404);
    expect(await readStatus(inSquad.caller, created.documentId)).toBe(404);
    expect(await readStatus("editor", created.documentId)).toBe(200);

    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: created.documentId });
    expect(await notified(created.documentId)).toEqual([inSquad.id]);

    // The thread answers like a missing target for a member.
    const hidden = await comment(outsider.caller, created.documentId);
    const missing = await comment(outsider.caller, "zzzzzzzzzzzzzzzzzzzzzzzz");
    expect([hidden.status, hidden.text]).toEqual([missing.status, missing.text]);
    expect(hidden.status).toBe(400);
  });

  it("an editor's explicit re-target in the admin panel lowers the marker", async () => {
    const unit = await department("FC Retarget Dept");
    const insider = await member(unit);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC retarget",
      department: unit.documentId,
    });
    const res = await panel.delete(DEPARTMENT, unit.documentId);
    expect(res.status, res.text).toBe(200);
    expect(await readStatus(salesMember, created.documentId)).toBe(404);
    const retarget = await panel.publish(ANNOUNCEMENT, created.documentId, {
      department: t.fixtures.departments.sales.documentId,
      retargetRequired: false,
    });
    expect(retarget.status, retarget.text).toBe(200);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", false],
      [true, "departments", false],
    ]);
    expect(await readStatus(salesMember, created.documentId)).toBe(200);
    expect(await notified(created.documentId)).toContain(salesMemberId);
    expect(await notified(created.documentId)).toContain(insider.id);
  });

  it("refuses a db-level department or team delete outside a transaction; inside one it runs", async () => {
    const unit = await department("FC Script Dept");
    const squad = await team("FC Script Squad", t.fixtures.departments.engineering);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC script delete",
      department: unit.documentId,
      team: squad.documentId,
    });
    // The query engine opens no transaction around a lifecycle and its
    // DELETE: the hook refuses, and nothing changes.
    await expect(t.strapi.db.query(DEPARTMENT).delete({ where: { id: unit.id } })).rejects.toThrow(
      /\[targeting-flags\] department delete: refused outside a transaction/,
    );
    await expect(t.strapi.db.query(TEAM).delete({ where: { id: squad.id } })).rejects.toThrow(
      /\[targeting-flags\] team delete: refused outside a transaction/,
    );
    expect(await t.strapi.db.query(DEPARTMENT).count({ where: { id: unit.id } })).toBe(1);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", false],
      [true, "departments", false],
    ]);
    // A script that wraps it in a transaction deletes with every safeguard.
    await t.strapi.db.transaction(() =>
      t.strapi.db.query(DEPARTMENT).delete({ where: { id: unit.id } }),
    );
    expect(await t.strapi.db.query(DEPARTMENT).count({ where: { id: unit.id } })).toBe(0);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
  });

  // ---------------------------------------------------------------------------
  // The boot backfill (lane 15B, utils/targeting-flags-backfill.ts) and what
  // a republish then notifies: the end of the legacy-unlink case (decision 06
  // §N10, moved here from 15B's suite, plan S4) and of the batch-14 discard
  // regression (plan review finding 1).

  interface Backfill {
    backfillTargetingFlags(strapi: unknown): Promise<unknown>;
  }

  /** The roll-forward's first boot: the targeting-flag backfill. */
  const backfill = () =>
    t.requireBuilt<Backfill>("src/utils/targeting-flags-backfill").backfillTargetingFlags(t.strapi);

  /** A raw column write on rows of `documentId` (as an old image or raw SQL leaves them). */
  const rawSet = async (
    uid: string,
    documentId: string,
    data: Params,
    which: "draft" | "both" = "both",
  ) => {
    const rows = await t.strapi.db.query(uid).findMany({
      where: { documentId },
      select: ["id", "publishedAt"],
    });
    for (const row of rows) {
      if (which === "draft" && row.publishedAt != null) continue;
      await t.strapi.db.query(uid).update({ where: { id: row.id }, data });
    }
  };

  it("legacy unlink: an event whose flag the backfill restored notifies nobody once its departments are removed", async () => {
    const unit = await department("FC Legacy Event Dept");
    const insider = await member(unit);
    const event = await publish(EVENT, {
      title: "IT FC legacy event",
      start: START,
      departments: [unit.documentId],
    });
    expect(await notified(event.documentId)).toEqual([insider.id]);
    // The pre-upgrade state: the column came up NULL on both rows.
    await rawSet(EVENT, event.documentId, { notifyAudience: null });
    expect(await eventFlags(event.documentId)).toEqual([
      [false, null],
      [true, null],
    ]);
    await backfill();
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    // Its departments removed in the admin panel, then republished: before
    // the backfill and the fan-out rule, the whole company was notified.
    const res = await panel.publish(EVENT, event.documentId, { departments: [] });
    expect(res.status, res.text).toBe(200);
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    expect(await notified(event.documentId)).toEqual([insider.id]);
  });

  it("legacy unlink: an 'all' announcement with a department link stays restricted once unlinked", async () => {
    const unit = await department("FC Legacy Ann Dept");
    const insider = await member(unit);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC legacy announcement",
      department: unit.documentId,
    });
    expect(await notified(created.documentId)).toEqual([insider.id]);
    // The pre-upgrade state: Audience 'all' next to the link.
    await rawSet(ANNOUNCEMENT, created.documentId, { audience: "all" });
    await backfill();
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", false],
      [true, "departments", false],
    ]);
    const res = await panel.publish(ANNOUNCEMENT, created.documentId, { department: null });
    expect(res.status, res.text).toBe(200);
    for (const caller of [insider.caller, salesMember, "member"] as Caller[]) {
      expect(await readStatus(caller, created.documentId), String(caller)).toBe(404);
    }
    expect(await notified(created.documentId)).toEqual([insider.id]);
  });

  it("batch-14 discard, roll-forward, republish: the twin rule keeps the event restricted, nobody is notified", async () => {
    const unit = await department("FC Twin Event Dept");
    const insider = await member(unit);
    const event = await publish(EVENT, {
      title: "IT FC twin event",
      start: START,
      departments: [unit.documentId],
    });
    expect((await panel.delete(DEPARTMENT, unit.documentId)).status).toBe(200);
    // Restricted only by its flag, on both rows.
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    // The batch-14 image's "Discard changes" rebuilds the draft from the
    // published row through a model without notify_audience: NULL.
    await rawSet(EVENT, event.documentId, { notifyAudience: null }, "draft");
    await backfill();
    // The twin rule: the draft takes 'departments' from its published twin
    // (a per-row rule alone would have written 'all').
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    await t.strapi.documents(EVENT).publish({ documentId: event.documentId });
    expect(await eventFlags(event.documentId)).toEqual([
      [false, "departments"],
      [true, "departments"],
    ]);
    expect(await notified(event.documentId)).toEqual([insider.id]);
  });

  it("batch-14 discard, roll-forward, republish: the twin rule keeps the marker, a member gets 404", async () => {
    const unit = await department("FC Twin Ann Dept");
    const squad = await team("FC Twin Ann Squad", t.fixtures.departments.engineering);
    const inSquad = await member(t.fixtures.departments.sales, [squad]);
    const created = await publish(ANNOUNCEMENT, {
      title: "IT FC twin announcement",
      department: unit.documentId,
      team: squad.documentId,
    });
    expect((await panel.delete(DEPARTMENT, unit.documentId)).status).toBe(200);
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    // The old image's discard: the draft comes back without the marker.
    await rawSet(ANNOUNCEMENT, created.documentId, { retargetRequired: null }, "draft");
    await backfill();
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: created.documentId });
    expect(await announcementFlags(created.documentId)).toEqual([
      [false, "departments", true],
      [true, "departments", true],
    ]);
    // The team survived: without the marker its Sales member would read
    // the announcement and be notified of the republish.
    expect(await readStatus(inSquad.caller, created.documentId)).toBe(404);
    expect(await notified(created.documentId)).toEqual([]);
  });

  it.runIf(engine === "postgres")(
    "a department link committed while the delete runs is marked, not cascaded open (Postgres lock)",
    async () => {
      const unit = await department("FC Race Dept");
      const squad = await team("FC Race Squad", t.fixtures.departments.engineering);
      const created = await publish(ANNOUNCEMENT, {
        title: "IT FC race",
        team: squad.documentId,
      });
      const rows = await t.strapi.db.query(ANNOUNCEMENT).findMany({
        where: { documentId: created.documentId },
        select: ["id"],
      });
      const before = await revision(ANNOUNCEMENT, created.documentId);
      // A save that links both rows to the department around the Document
      // Service (raw SQL, as a previous cms during a rollback), still open
      // when the delete starts. Unlocked, the scan would miss it and the
      // cascade would leave the team alone: the whole team, across
      // departments, would read a department-plus-team announcement.
      const edit = await holdTransaction(t);
      let deleting: Promise<Settled<unknown>> | undefined;
      try {
        for (const row of rows) {
          await edit.raw(
            `INSERT INTO ${qualified(t, "announcements_department_lnk")} (announcement_id, department_id) VALUES (?, ?)`,
            [row.id, unit.id],
          );
        }
        deleting = settle(t.strapi.documents(DEPARTMENT).delete({ documentId: unit.documentId }));
        await waitForLockWait(t);
        await edit.commit();
      } catch (err) {
        await edit.rollback();
        throw err;
      }
      expect(await deleting).toMatchObject({ ok: true });
      expect(await announcementFlags(created.documentId)).toEqual([
        [false, "departments", true],
        [true, "departments", true],
      ]);
      expect(await readStatus("team_lead", created.documentId)).toBe(404);
      // The lock comes before the scan for the revision advance too: a gate
      // that saw the rows before the link fails its comparison.
      expect(await revision(ANNOUNCEMENT, created.documentId)).toBe(before + 1);
    },
  );

  it.runIf(engine === "postgres")(
    "the four read-only diagnostics run on the live schema and list exactly the seeded rows",
    async () => {
      // Seed what each file is about, on top of the rows of the cases above.
      const legacy = await publish(ANNOUNCEMENT, {
        title: "IT FC diag no target",
        audience: "departments",
      });
      const unit = await department("FC Diag Dept");
      const squad = await team("FC Diag Squad", t.fixtures.departments.engineering);
      // Marked, with its team left: not a D-PT01 row.
      const marked = await publish(ANNOUNCEMENT, {
        title: "IT FC diag marked",
        department: unit.documentId,
        team: squad.documentId,
      });
      const flagOnly = await publish(EVENT, {
        title: "IT FC diag event",
        start: START,
        departments: [unit.documentId],
      });
      expect((await panel.delete(DEPARTMENT, unit.documentId)).status).toBe(200);
      const scheduled = await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: "IT FC diag scheduled", publishAt: "2031-01-01T08:00:00.000Z" },
      });
      const withdrawing = await t.strapi.documents("api::quick-link.quick-link").create({
        data: { label: "IT FC diag link", url: "https://example.test" },
        status: "published",
      });
      await t.strapi.documents("api::quick-link.quick-link").update({
        documentId: withdrawing.documentId,
        data: { unpublishAt: "2031-02-01T08:00:00.000Z" },
      });
      const headless = await createUser(t, "department_head", null);

      const { Client } = requireCmsDependency<{
        Client: new (config: { connectionString: string }) => PgClient;
      }>("pg");
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      const run = async (file: string) => {
        await client.query(`SET search_path TO "${testSchema(t)}"`);
        const results = await client.query(diagnostic(file));
        const list = Array.isArray(results) ? results : [results];
        // Read-only: it opens a read-only transaction and rolls it back.
        expect(list[0].command, file).toBe("BEGIN");
        expect(list[list.length - 1].command, file).toBe("ROLLBACK");
        return list.filter((result) => result.command === "SELECT").map((result) => result.rows);
      };
      try {
        const [preflightSummary, preflightRows] = await run("announcement-audience-preflight.sql");
        const legacyDocuments = new Set(preflightRows.map((row) => row.document_id));
        expect(legacyDocuments.has(legacy.documentId)).toBe(true);
        expect(legacyDocuments.has(marked.documentId)).toBe(false);
        expect(Number(preflightSummary[0].documents)).toBe(legacyDocuments.size);
        expect(
          preflightRows
            .filter((row) => row.document_id === legacy.documentId)
            .map((row) => row.status),
        ).toEqual(["published", "draft"]);

        const [retargetSummary, markedRows, eventRows] = await run("announcement-retarget.sql");
        expect(
          markedRows
            .filter((row) => row.document_id === marked.documentId)
            .map((row) => [row.status, row.links_department, row.links_team]),
        ).toEqual([
          ["published", false, true],
          ["draft", false, true],
        ]);
        expect(
          eventRows
            .filter((row) => row.document_id === flagOnly.documentId)
            .map((row) => row.status),
        ).toEqual(["published", "draft"]);
        expect(Number(retargetSummary[0].flag_only_events)).toBe(
          new Set(eventRows.map((row) => row.document_id)).size,
        );

        const [schedules] = await run("schedule-export.sql");
        const byDocument = new Map(schedules.map((row) => [row.document_id, row]));
        expect(byDocument.get(scheduled.documentId)).toMatchObject({
          table_name: "announcements",
          label: "IT FC diag scheduled",
          published: false,
          withdraw_by_hand: false,
          unpublish_at: null,
        });
        expect(byDocument.get(withdrawing.documentId)).toMatchObject({
          table_name: "quick_links",
          label: "IT FC diag link",
          publish_at: null,
          published: true,
          withdraw_by_hand: true,
        });
        expect(schedules).toHaveLength(2);

        const [departments, mismatches] = await run("department-heads.sql");
        const engineering = departments.find(
          (row) => row.department_id === t.fixtures.departments.engineering.id,
        );
        expect(engineering).toMatchObject({ head_role: "department_head" });
        expect(String(engineering?.department_heads)).toContain(
          t.fixtures.users.department_head.username,
        );
        const kinds = (kind: string) =>
          mismatches
            .filter((row) => row.kind === kind)
            .map((row) => row.username ?? row.department);
        expect(kinds("department_head_without_department")).toContain(headless.username);
        expect(kinds("department_without_head_role")).toContain(t.fixtures.departments.sales.name);
        expect(kinds("head_without_role")).toEqual([]);
        expect(kinds("head_of_other_department")).toEqual([]);
        for (const row of [...departments, ...mismatches]) {
          expect(Object.keys(row)).not.toContain("email");
        }
      } finally {
        await client.end();
      }
    },
  );
});
