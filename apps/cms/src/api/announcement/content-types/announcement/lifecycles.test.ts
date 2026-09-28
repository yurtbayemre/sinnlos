/**
 * Announcement notification fan-out (S08 characterisation).
 *
 * Drives the real lifecycle against the shared Strapi stub with the
 * organisation of test/org-fixtures.test.helper.ts. Pinned: which users a
 * published announcement notifies (targeting, author exclusion), the row it
 * writes per recipient (one create() each, never createMany), the re-publish
 * dedup of issue #12, both hooks, and WHEN the fan-out runs relative to the
 * publish transaction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_USERS,
  ANNOUNCEMENT_UID,
  DEPT,
  NOTIFICATION_UID,
  ROLE,
  TEAM,
  USER,
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

describe("announcement afterCreate: audience", () => {
  it("an untargeted announcement notifies every user but its author", async () => {
    const strapi = setup();
    const row = publish(strapi, {});
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual(ALL_USERS.filter((id) => id !== USER.carol));
  });

  it("department targeting: only that department", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.engineering } });
    await lifecycles.afterCreate({ result: row });
    // carol (author) is out; gina (guest) and bert (blocked) are in the
    // department and are notified today.
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.gina, USER.bert]);
  });

  it("team targeting: members AND the lead, who is no member", async () => {
    const strapi = setup();
    const row = publish(strapi, { team: { id: TEAM.frontend } });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.dave]);
  });

  it("role targeting: only those roles", async () => {
    const strapi = setup();
    const row = publish(strapi, { audienceRoles: [{ id: ROLE.member }, { id: ROLE.guest }] });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.bob, USER.gina, USER.bert]);
  });

  it("criteria are AND-combined", async () => {
    const strapi = setup();
    const row = publish(strapi, {
      department: { id: DEPT.engineering },
      audienceRoles: [{ id: ROLE.member }],
    });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual([USER.alice, USER.bert]);
  });

  it("admins and editors get only the targeted audience (no bypass)", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales }, author: { id: USER.alice } });
    await lifecycles.afterCreate({ result: row });
    // anna (admin_role) is in Sales, carol (editor) is not.
    expect(recipientsOf(strapi)).toEqual([USER.bob, USER.dave, USER.anna]);
  });

  it("an announcement without an author notifies everyone", async () => {
    const strapi = setup();
    const row = publish(strapi, { author: null });
    await lifecycles.afterCreate({ result: row });
    expect(recipientsOf(strapi)).toEqual(ALL_USERS);
    expect(notificationRows(strapi).every((n) => n.actor === null)).toBe(true);
  });
});

describe("announcement afterCreate: the rows it writes", () => {
  it("one create() per recipient with the anchored notification", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.engineering } });
    await lifecycles.afterCreate({ result: row });

    const creates = strapi.calls.filter((call) => call.uid === NOTIFICATION_UID);
    expect(creates.map((call) => call.method)).toEqual(["findMany", "create", "create", "create"]);
    expect(notificationRows(strapi)[0]).toMatchObject({
      type: "announcement",
      title: "New announcement: Town hall",
      link: "/announcements",
      recipient: { id: USER.alice },
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

  it("does not truncate: a 250-character title makes a 268-character notification title", async () => {
    const strapi = setup();
    const title = "x".repeat(250);
    const row = publish(strapi, { title, department: { id: DEPT.sales } });
    await lifecycles.afterCreate({ result: row });
    expect(String(notificationRows(strapi)[0].title)).toHaveLength(268);
  });
});

describe("announcement re-publish dedup (issue #12)", () => {
  it("a re-publish (new row id, same documentId) notifies nobody twice", async () => {
    const strapi = setup();
    const first = publish(strapi, { department: { id: DEPT.engineering } });
    await lifecycles.afterCreate({ result: first });
    expect(notificationRows(strapi)).toHaveLength(3);

    const [republished] = (await strapi.documents(ANNOUNCEMENT_UID).publish({
      documentId: String(first.documentId),
    })).entries;
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
    const [republished] = (await strapi.documents(ANNOUNCEMENT_UID).publish({
      documentId: String(first.documentId),
    })).entries;
    await lifecycles.afterCreate({ result: republished });
    expect(recipientsOf(strapi)).toEqual(
      [USER.alice, USER.gina, USER.bert, USER.bob, USER.dave, USER.anna].sort((a, b) => a - b),
    );
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

  it("a row that cannot be re-read targets everyone (fallback)", async () => {
    const strapi = setup();
    await lifecycles.afterCreate({
      result: { id: 999, documentId: "k3v9q2m8x7c4b1n6p5z0r2t8", title: "Gone", publishedAt: "2026-09-28T08:00:00.000Z" },
    });
    expect(recipientsOf(strapi)).toEqual(ALL_USERS);
  });

  it("never throws: a failing insert is logged and the hook resolves", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const q = query(uid);
      if (uid !== NOTIFICATION_UID) return q;
      return {
        ...q,
        create: async () => {
          throw new Error('value too long for type character varying(255)');
        },
      };
    };
    await expect(lifecycles.afterCreate({ result: row })).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed to create notifications for announcement: value too long for type character varying(255)",
    );
  });
});

describe("announcement fan-out and the publish transaction", () => {
  it("runs INSIDE the publish transaction: the rows exist before the commit", async () => {
    const strapi = setup();
    const row = publish(strapi, { department: { id: DEPT.sales } });
    let rowsBeforeCommit = -1;
    await strapi.db.transaction(async () => {
      await lifecycles.afterCreate({ result: row });
      rowsBeforeCommit = notificationRows(strapi).length;
    });
    expect(rowsBeforeCommit).toBe(3);
  });
});
