/**
 * Event notification fan-out (S08 characterisation), against the shared
 * Strapi stub with the organisation of test/org-fixtures.test.helper.ts:
 * department targeting, organizer exclusion, the anchored row per
 * recipient, the re-publish dedup and the hooks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_USERS,
  DEPT,
  EVENT_UID,
  NOTIFICATION_UID,
  PERMISSION_UID,
  ROLE,
  USER,
  USER_UID,
  createOrgStub,
  recipientsOf,
} from "../../../../test/org-fixtures.test.helper";
import type { Row, StrapiStub } from "../../../../test/strapi-stub.test.helper";
import lifecycles from "./lifecycles";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const strapi = createOrgStub();
  vi.stubGlobal("strapi", strapi);
  return strapi;
}

function publish(strapi: StrapiStub, data: Record<string, unknown>): Row {
  const { published } = strapi.seedDocument(
    EVENT_UID,
    {
      title: "Summer party",
      start: "2026-10-01T16:00:00.000Z",
      organizer: { id: USER.carol },
      departments: [],
      ...data,
    },
    { status: "published" },
  );
  if (!published) throw new Error("no published row");
  return published;
}

const notificationRows = (strapi: StrapiStub) => strapi.tables[NOTIFICATION_UID] ?? [];

/** Active users holding event.find: everyone but bert (blocked); guest reads the calendar. */
const READERS = ALL_USERS.filter((id) => id !== USER.bert);

describe("event afterCreate", () => {
  it("an event without departments notifies every reader but the organizer", async () => {
    const strapi = setup();
    const row = publish(strapi, {});
    await lifecycles.afterCreate({ result: row });
    // FX19: the blocked user is out; the guest holds event.find and stays in.
    expect(recipientsOf(strapi)).toEqual(READERS.filter((id) => id !== USER.carol));
  });

  it("departments restrict to their members", async () => {
    const strapi = setup();
    const row = publish(strapi, { departments: [{ id: DEPT.engineering }] });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.gina]);
  });

  it("several departments, and users without one only for untargeted events", async () => {
    const strapi = setup();
    for (const user of strapi.tables[USER_UID]) if (user.id === USER.bob) user.department = null;
    const both = publish(strapi, {
      departments: [{ id: DEPT.engineering }, { id: DEPT.sales }],
    });
    await lifecycles.afterCreate({ result: both });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.dave, USER.gina, USER.anna]);

    const untargeted = publish(strapi, {});
    await lifecycles.afterCreate({ result: untargeted });
    expect(recipientsOf(strapi, (n) => n.sourceDocumentId === untargeted.documentId)).toContain(
      USER.bob,
    );
  });

  it("the read grant comes from up_permissions: a role without event.find is out", async () => {
    const strapi = setup();
    strapi.tables[PERMISSION_UID] = strapi.tables[PERMISSION_UID].filter(
      (p) =>
        !(p.action === "api::event.event.find" && (p.role as { id: number }).id === ROLE.guest),
    );
    const row = publish(strapi, { departments: [{ id: DEPT.engineering }] });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice]);
  });

  it("writes one anchored row per recipient", async () => {
    const strapi = setup();
    const row = publish(strapi, { departments: [{ id: DEPT.sales }] });
    await lifecycles.afterCreate({ result: row });
    const calls = strapi.calls.filter((call) => call.uid === NOTIFICATION_UID);
    expect(calls.map((call) => call.method)).toEqual(["findMany", "create", "create", "create"]);
    expect(notificationRows(strapi)[0]).toMatchObject({
      type: "event",
      title: "New event: Summer party",
      link: "/events",
      recipient: { id: USER.bob },
      actor: { id: USER.carol },
      sourceType: "event",
      sourceDocumentId: row.documentId,
    });
    expect(strapi.log.info).toHaveBeenCalledWith(
      `[notifications] created 3 notification(s) for event ${row.id} (source ${row.documentId})`,
    );
  });

  it("truncates the title to varchar(255) (FX18)", async () => {
    const strapi = setup();
    const row = publish(strapi, { title: "y".repeat(250), departments: [{ id: DEPT.sales }] });
    await lifecycles.afterCreate({ result: row });
    expect(String(notificationRows(strapi)[0].title)).toBe(`New event: ${"y".repeat(243)}…`);
  });

  it("a re-publish notifies nobody twice", async () => {
    const strapi = setup();
    const row = publish(strapi, { departments: [{ id: DEPT.sales }] });
    await lifecycles.afterCreate({ result: row });
    const [again] = (
      await strapi.documents(EVENT_UID).publish({ documentId: String(row.documentId) })
    ).entries;
    await lifecycles.afterCreate({ result: again });
    expect(notificationRows(strapi)).toHaveLength(3);
  });

  it("a republish before the fan-out ran: the current title for the current audience", async () => {
    const strapi = setup();
    const row = publish(strapi, { title: "Sales kick-off", departments: [{ id: DEPT.sales }] });
    const draft = strapi.tables[EVENT_UID].find(
      (r) => r.documentId === row.documentId && r.publishedAt === null,
    );
    if (!draft) throw new Error("no draft");
    draft.title = "Company kick-off";
    draft.departments = [];
    const [again] = (
      await strapi.documents(EVENT_UID).publish({ documentId: String(row.documentId) })
    ).entries;

    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual(READERS.filter((id) => id !== USER.carol));
    expect(new Set(notificationRows(strapi).map((n) => n.title))).toEqual(
      new Set(["New event: Company kick-off"]),
    );
    const written = notificationRows(strapi).length;
    await lifecycles.afterCreate({ result: again });
    expect(notificationRows(strapi)).toHaveLength(written);
  });

  it("a draft touches no data; afterUpdate with publishedAt fans out", async () => {
    const strapi = setup();
    await lifecycles.afterCreate({ result: { id: 1, publishedAt: null } });
    await lifecycles.afterUpdate({ result: { id: 1, publishedAt: null } });
    expect(strapi.calls).toEqual([]);
    const row = publish(strapi, { departments: [{ id: DEPT.sales }] });
    await lifecycles.afterUpdate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("a row that cannot be re-read notifies nobody (targeting unknown, FX19)", async () => {
    const strapi = setup();
    await lifecycles.afterCreate({
      result: {
        id: 999,
        documentId: "k3v9q2m8x7c4b1n6p5z0r2t8",
        title: "Gone",
        publishedAt: "2026-09-28T08:00:00.000Z",
      },
    });
    expect(recipientsOf(strapi)).toEqual([]);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "[notifications] event 999 could not be re-read, nobody notified (targeting unknown)",
    );
  });

  it("runs after the publish commits (LF02), a rollback notifies nobody, never throws", async () => {
    const strapi = setup();
    const row = publish(strapi, { departments: [{ id: DEPT.sales }] });
    await expect(
      strapi.db.transaction(async () => {
        await lifecycles.afterCreate({ result: row });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(notificationRows(strapi)).toEqual([]);

    let before = -1;
    await strapi.db.transaction(async () => {
      await lifecycles.afterCreate({ result: row });
      before = notificationRows(strapi).length;
    });
    expect(before).toBe(0);
    expect(notificationRows(strapi)).toHaveLength(3);

    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      if (uid === EVENT_UID) throw new Error("db down");
      return query(uid);
    };
    await expect(lifecycles.afterCreate({ result: row })).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed to create notifications for event: db down",
    );
  });
});
