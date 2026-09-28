/**
 * Kudos notification (S08 characterisation): the recipient of a kudos gets
 * one notification from the giver; self-kudos and incomplete rows notify
 * nobody. Written after the kudos' transaction commits, in a transaction
 * of its own (LF02), so a failing notification never costs the kudos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KUDOS_UID,
  NOTIFICATION_UID,
  USER,
  USER_UID,
  createOrgStub,
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

const kudos = (strapi: StrapiStub, data: Record<string, unknown>): Promise<Row> =>
  strapi.db.query(KUDOS_UID).create({ data: { message: "Thanks!", value: "teamwork", ...data } });

const notificationRows = (strapi: StrapiStub) => strapi.tables[NOTIFICATION_UID] ?? [];

const renameUser = (strapi: StrapiStub, id: number, displayName: string | null) => {
  const row = strapi.tables[USER_UID].find((user) => user.id === id);
  if (!row) throw new Error(`no user ${id}`);
  row.displayName = displayName;
};

describe("kudos afterCreate", () => {
  it("notifies the recipient", async () => {
    const strapi = setup();
    const row = await kudos(strapi, { from: USER.alice, to: USER.bob });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)).toHaveLength(1);
    expect(notificationRows(strapi)[0]).toMatchObject({
      type: "kudos",
      title: "Alice gave you kudos!",
      link: "/kudos",
      recipient: { id: USER.bob },
      actor: { id: USER.alice },
    });
  });

  it("self-kudos and rows without both ends notify nobody", async () => {
    const strapi = setup();
    await lifecycles.afterCreate({
      result: await kudos(strapi, { from: USER.alice, to: USER.alice }),
    });
    await lifecycles.afterCreate({ result: await kudos(strapi, { from: USER.alice }) });
    await lifecycles.afterCreate({ result: await kudos(strapi, { to: USER.bob }) });
    await lifecycles.afterCreate({ result: { id: 4242 } });
    expect(notificationRows(strapi)).toEqual([]);
  });

  it("falls back to 'Someone' and truncates a long name (FX18)", async () => {
    const strapi = setup();
    renameUser(strapi, USER.alice, null);
    await lifecycles.afterCreate({
      result: await kudos(strapi, { from: USER.alice, to: USER.bob }),
    });
    expect(notificationRows(strapi)[0].title).toBe("Someone gave you kudos!");

    renameUser(strapi, USER.alice, "   ");
    await lifecycles.afterCreate({
      result: await kudos(strapi, { from: USER.alice, to: USER.bob }),
    });
    expect(notificationRows(strapi)[1].title).toBe("Someone gave you kudos!");

    renameUser(strapi, USER.alice, "n".repeat(250));
    await lifecycles.afterCreate({
      result: await kudos(strapi, { from: USER.alice, to: USER.bob }),
    });
    expect(notificationRows(strapi)[2].title).toBe(`${"n".repeat(238)}… gave you kudos!`);
  });

  it("writes after the kudos' transaction commits; a rollback notifies nobody (LF02)", async () => {
    const strapi = setup();
    const row = await kudos(strapi, { from: USER.alice, to: USER.bob });
    await expect(
      strapi.db.transaction(async () => {
        await lifecycles.afterCreate({ result: row });
        throw new Error("kudos create failed");
      }),
    ).rejects.toThrow("kudos create failed");
    expect(notificationRows(strapi)).toEqual([]);

    let before = -1;
    await strapi.db.transaction(async () => {
      await lifecycles.afterCreate({ result: row });
      before = notificationRows(strapi).length;
    });
    expect(before).toBe(0);
    expect(notificationRows(strapi)).toHaveLength(1);
  });

  it("a failing notification INSERT costs the notification only, never the kudos", async () => {
    const strapi = setup();
    const row = await kudos(strapi, { from: USER.alice, to: USER.bob });
    const query = strapi.db.query.bind(strapi.db);
    const insertInTransaction: boolean[] = [];
    strapi.db.query = (uid: string) => {
      const q = query(uid);
      if (uid !== NOTIFICATION_UID) return q;
      return {
        ...q,
        create: async () => {
          insertInTransaction.push(strapi.db.inTransaction());
          throw new Error("insert failed");
        },
      };
    };
    const rolledBack = vi.fn();
    await expect(
      strapi.db.transaction(async ({ onRollback }) => {
        onRollback(rolledBack);
        await lifecycles.afterCreate({ result: row });
        return "created";
      }),
    ).resolves.toBe("created");
    expect(rolledBack).not.toHaveBeenCalled();
    // The insert ran after the commit, in a transaction of its own.
    expect(insertInTransaction).toEqual([true]);
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed for kudos: insert failed",
    );
  });

  it("never throws", async () => {
    const strapi = setup();
    const row = await kudos(strapi, { from: USER.alice, to: USER.bob });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      if (uid === KUDOS_UID) throw new Error("db down");
      return query(uid);
    };
    await expect(lifecycles.afterCreate({ result: row })).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith("[notifications] failed for kudos: db down");
  });
});
