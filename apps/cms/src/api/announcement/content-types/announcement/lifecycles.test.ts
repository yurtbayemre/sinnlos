/**
 * Announcement notification fan-out (S08 characterisation).
 *
 * Drives the real lifecycle against the shared Strapi stub with the
 * organisation of test/org-fixtures.test.helper.ts. Pinned: which users a
 * published announcement notifies (targeting AND announcement.find AND not
 * blocked since FX19, author exclusion), the row it
 * writes per recipient (one create() each, never createMany), the re-publish
 * dedup of issue #12, both hooks, and WHEN the fan-out runs relative to the
 * publish transaction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_UID,
  DEPT,
  NOTIFICATION_UID,
  ROLE,
  TEAM,
  USER,
  createOrgStub,
  recipientsOf,
} from "../../../../test/org-fixtures.test.helper";
import type { Row, StrapiStub, TransactionScope } from "../../../../test/strapi-stub.test.helper";
import lifecycles from "./lifecycles";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const strapi = createOrgStub();
  vi.stubGlobal("strapi", strapi);
  return strapi;
}

/** Publishes an announcement the way the Document Service leaves it: draft + published row. */
function publish(strapi: StrapiStub, data: Record<string, unknown>, documentId?: string): Row {
  const { published } = strapi.seedDocument(
    ANNOUNCEMENT_UID,
    { title: "Town hall", author: { id: USER.carol }, ...data },
    { status: "published", documentId },
  );
  if (!published) throw new Error("no published row");
  return published;
}

const notificationRows = (strapi: StrapiStub) => strapi.tables[NOTIFICATION_UID] ?? [];

/** Every active user holding announcement.find: not gina (guest), not bert (blocked). */
const READERS = [USER.alice, USER.bob, USER.carol, USER.dave, USER.anna];

describe("announcement afterCreate: audience = targeting AND read grant AND active (FX19)", () => {
  it("an untargeted announcement notifies every reader but its author", async () => {
    const strapi = setup();
    const row = publish(strapi, {});
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual(READERS.filter((id) => id !== USER.carol));
  });

  it("department targeting: only that department; guest and blocked are out", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.engineering } });
    await lifecycles.afterCreate({ result: row });
    // carol is the author; gina (guest: no announcement.find) and bert
    // (blocked) were notified before FX19.
    expect(recipientsOf(strapi)).toEqual([USER.alice]);
  });

  it("team targeting: members AND the lead, who is no member", async () => {
    const strapi = setup();
    const row = publish(strapi, { team: { id: TEAM.frontend } });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.dave]);
  });

  it("role targeting: a targeted guest role still reaches no guest", async () => {
    const strapi = setup();
    const row = publish(strapi, { audienceRoles: [{ id: ROLE.member }, { id: ROLE.guest }] });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.bob]);
  });

  it("criteria are AND-combined", async () => {
    const strapi = setup();
    const row = publish(strapi, {
      department: { id: DEPT.sales },
      audienceRoles: [{ id: ROLE.member }, { id: ROLE.teamLead }],
    });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave]);
  });

  it("admins and editors get only the targeted audience (owner default: no bypass)", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales }, author: { id: USER.alice } });
    await lifecycles.afterCreate({ result: row });
    // anna (admin_role) is in Sales, carol (editor) is not.
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("an announcement without an author notifies every reader", async () => {
    const strapi = setup();
    const row = publish(strapi, { author: null });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual(READERS);
    expect(notificationRows(strapi).every((n) => n.actor === null)).toBe(true);
  });

  it("the read grant comes from up_permissions at runtime", async () => {
    const strapi = setup();
    // An admin revokes announcement.find from member in the admin panel.
    strapi.tables["plugin::users-permissions.permission"] = strapi.tables[
      "plugin::users-permissions.permission"
    ].filter(
      (p) =>
        !(
          p.action === "api::announcement.announcement.find" &&
          (p.role as { id: number }).id === ROLE.member
        ),
    );
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.dave, USER.anna]);
  });

  it("without any grant row nobody is notified (fail-closed)", async () => {
    const strapi = createOrgStub({ grants: false });
    vi.stubGlobal("strapi", strapi);
    const row = publish(strapi, {});
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([]);
  });

  it("a user without a role holds no grant", async () => {
    const strapi = setup();
    for (const user of strapi.tables["plugin::users-permissions.user"]) {
      if (user.id === USER.bob) user.role = null;
    }
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.dave, USER.anna]);
  });

  it("a user whose blocked flag is NULL is active", async () => {
    const strapi = setup();
    for (const user of strapi.tables["plugin::users-permissions.user"]) {
      if (user.id === USER.bob) user.blocked = null;
    }
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("loads users, teams and grants once, whatever the audience size", async () => {
    const strapi = setup();
    const row = publish(strapi, {});
    await lifecycles.afterCreate({ result: row });
    const reads = strapi.calls
      .filter((call) => call.method !== "create")
      .map((call) => `${call.method} ${call.uid}`)
      .sort();
    expect(reads).toEqual(
      [
        "findMany api::notification.notification",
        "findMany api::team.team",
        "findMany plugin::users-permissions.permission",
        "findMany plugin::users-permissions.user",
        "findOne api::announcement.announcement",
      ].sort(),
    );
  });
});

describe("announcement afterCreate: the rows it writes", () => {
  it("one create() per recipient with the anchored notification", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });

    const creates = strapi.calls.filter((call) => call.uid === NOTIFICATION_UID);
    expect(creates.map((call) => call.method)).toEqual(["findMany", "create", "create", "create"]);
    expect(notificationRows(strapi)[0]).toMatchObject({
      type: "announcement",
      title: "New announcement: Town hall",
      link: "/announcements",
      recipient: { id: USER.bob },
      actor: { id: USER.carol },
      sourceType: "announcement",
      sourceDocumentId: row.documentId,
    });
    expect(strapi.log.info).toHaveBeenCalledWith(
      `[notifications] created 3 notification(s) for announcement ${row.id} (source ${row.documentId})`,
    );
  });

  it("falls back to 'Untitled'", async () => {
    const strapi = setup();
    const row = publish(strapi, { title: null, department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)[0].title).toBe("New announcement: Untitled");
  });

  it("truncates: a 250-character title fits varchar(255), prefix kept (FX18)", async () => {
    const strapi = setup();
    const title = "x".repeat(250);
    const row = publish(strapi, { title, department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    const stored = String(notificationRows(strapi)[0].title);
    expect(stored).toHaveLength(255);
    expect(stored).toBe(`New announcement: ${"x".repeat(236)}…`);
  });
});

describe("announcement re-publish dedup (issue #12)", () => {
  it("a re-publish (new row id, same documentId) notifies nobody twice", async () => {
    const strapi = setup();
    const first = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: first });
    expect(notificationRows(strapi)).toHaveLength(3);

    const [republished] = (
      await strapi.documents(ANNOUNCEMENT_UID).publish({
        documentId: String(first.documentId),
      })
    ).entries;
    expect(republished.id).not.toBe(first.id);
    await lifecycles.afterCreate({ result: republished });
    expect(notificationRows(strapi)).toHaveLength(3);
    expect(strapi.log.info).toHaveBeenCalledWith(
      expect.stringContaining("3 of 3 recipient(s) already notified, 0 new"),
    );
  });

  it("a retargeted re-publish reaches only the new audience", async () => {
    const strapi = setup();
    const first = publish(strapi, { department: { id: DEPT.engineering } });
    await lifecycles.afterCreate({ result: first });
    const draft = strapi.tables[ANNOUNCEMENT_UID].find(
      (r) => r.documentId === first.documentId && r.publishedAt === null,
    );
    if (!draft) throw new Error("no draft");
    draft.department = { id: DEPT.sales };
    const [republished] = (
      await strapi.documents(ANNOUNCEMENT_UID).publish({
        documentId: String(first.documentId),
      })
    ).entries;
    await lifecycles.afterCreate({ result: republished });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.bob, USER.dave, USER.anna]);
  });
});

describe("announcement hooks", () => {
  it("a draft (publishedAt null) touches no data at all", async () => {
    const strapi = setup();
    await lifecycles.afterCreate({ result: { id: 1, documentId: "d1", publishedAt: null } });
    await lifecycles.afterUpdate({ result: { id: 1, documentId: "d1", publishedAt: null } });
    expect(strapi.calls).toEqual([]);
  });

  it("afterUpdate with publishedAt runs the same deduped fan-out", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await lifecycles.afterUpdate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)).toHaveLength(3);
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
      "[notifications] announcement 999 could not be re-read, nobody notified (targeting unknown)",
    );
  });

  it("never throws: a failing load is logged and the hook resolves", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      if (uid === "plugin::users-permissions.permission") throw new Error("db down");
      return query(uid);
    };
    await expect(lifecycles.afterCreate({ result: row })).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed to create notifications for announcement: db down",
    );
  });
});

/** Makes the notification INSERT for `recipient` fail like Postgres 22001; returns the undo. */
function failInsertFor(strapi: StrapiStub, recipient: number): () => void {
  const query = strapi.db.query.bind(strapi.db);
  const original = strapi.db.query;
  strapi.db.query = (uid: string) => {
    const q = query(uid);
    if (uid !== NOTIFICATION_UID) return q;
    return {
      ...q,
      create: async (params: { data: Record<string, unknown> }) => {
        if (params.data.recipient === recipient) {
          throw new Error("value too long for type character varying(255)");
        }
        return q.create(params);
      },
    };
  };
  return () => {
    strapi.db.query = original;
  };
}

describe("announcement fan-out after the publish commits (LF02)", () => {
  it("nothing is written while the publish is open; the commit runs the fan-out", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    let rowsBeforeCommit = -1;
    await strapi.db.transaction(async () => {
      await lifecycles.afterCreate({ result: row });
      rowsBeforeCommit = notificationRows(strapi).length;
    });
    expect(rowsBeforeCommit).toBe(0);
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("a nested transaction defers to the outer commit", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    let afterInner = -1;
    await strapi.db.transaction(async () => {
      await strapi.db.transaction(() => lifecycles.afterCreate({ result: row }));
      afterInner = notificationRows(strapi).length;
    });
    expect(afterInner).toBe(0);
    expect(notificationRows(strapi)).toHaveLength(3);
  });

  it("a publish that rolls back notifies nobody", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    await expect(
      strapi.db.transaction(async () => {
        await lifecycles.afterCreate({ result: row });
        throw new Error("relation sync failed");
      }),
    ).rejects.toThrow("relation sync failed");
    expect(notificationRows(strapi)).toEqual([]);
    expect(strapi.calls.some((call) => call.uid === NOTIFICATION_UID)).toBe(false);
  });

  it("a throwing insert neither rolls back the publish nor stops the other rows", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    const undo = failInsertFor(strapi, USER.dave);
    const rolledBack = vi.fn();
    await expect(
      strapi.db.transaction(async ({ onRollback }) => {
        onRollback(rolledBack);
        await lifecycles.afterCreate({ result: row });
        return "published";
      }),
    ).resolves.toBe("published");
    expect(rolledBack).not.toHaveBeenCalled();
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.anna]);
    expect(strapi.log.error).toHaveBeenCalledWith(
      `[notifications] could not create the notification for user ${USER.dave} (announcement ${row.id} (source ${row.documentId})): value too long for type character varying(255)`,
    );
    expect(strapi.log.info).toHaveBeenCalledWith(
      `[notifications] created 2 notification(s) for announcement ${row.id} (source ${row.documentId}), 1 failed`,
    );
    // The next publish delivers the missing one (#12 dedup per recipient).
    undo();
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("each notification insert runs in a transaction of its own", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    const transaction = strapi.db.transaction;
    const depths: boolean[] = [];
    strapi.db.transaction = <T>(callback: (scope: TransactionScope) => Promise<T> | T) =>
      transaction((scope) => {
        depths.push(strapi.db.inTransaction());
        return callback(scope);
      });
    await lifecycles.afterCreate({ result: row });
    // No publish transaction here: three per-row transactions, nothing else.
    expect(depths).toEqual([true, true, true]);
  });

  it("the fan-out re-reads the CURRENT published row by documentId", async () => {
    const strapi = setup();
    const first = publish(strapi, { department: { id: DEPT.engineering } });
    // A second publish retargets to Sales and replaces the row before the
    // first publish's fan-out ran.
    const draft = strapi.tables[ANNOUNCEMENT_UID].find(
      (r) => r.documentId === first.documentId && r.publishedAt === null,
    );
    if (!draft) throw new Error("no draft");
    draft.department = { id: DEPT.sales };
    await strapi.documents(ANNOUNCEMENT_UID).publish({ documentId: String(first.documentId) });
    await lifecycles.afterCreate({ result: first });
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });
});
