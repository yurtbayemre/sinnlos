/**
 * Comment notification (S08 characterisation): a comment or a reply on an
 * announcement notifies the announcement's author, resolved through the
 * documentId anchor (issue #11); nothing else notifies anybody.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_UID,
  COMMENT_UID,
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
  const { documentId, published } = strapi.seedDocument(
    ANNOUNCEMENT_UID,
    { title: "Town hall", author: { id: USER.carol } },
    { status: "published" },
  );
  if (!published) throw new Error("no published row");
  return { strapi, announcement: documentId };
}

async function comment(strapi: StrapiStub, data: Record<string, unknown>): Promise<Row> {
  return strapi.db.query(COMMENT_UID).create({
    data: { body: "Nice", targetType: "announcement", ...data },
  });
}

const notificationRows = (strapi: StrapiStub) => strapi.tables[NOTIFICATION_UID] ?? [];

describe("comment afterCreate", () => {
  it("notifies the announcement author about someone else's comment", async () => {
    const { strapi, announcement } = setup();
    const row = await comment(strapi, { author: USER.alice, targetDocumentId: announcement });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)).toHaveLength(1);
    expect(notificationRows(strapi)[0]).toMatchObject({
      type: "comment",
      title: 'Alice commented on "Town hall"',
      link: "/announcements",
      recipient: { id: USER.carol },
      actor: { id: USER.alice },
    });
    expect(notificationRows(strapi)[0]).not.toHaveProperty("sourceType");
  });

  it("a reply notifies the announcement author, not the parent comment's author", async () => {
    const { strapi, announcement } = setup();
    const parent = await comment(strapi, { author: USER.bob, targetDocumentId: announcement });
    const reply = await comment(strapi, {
      author: USER.alice,
      targetDocumentId: announcement,
      parent: parent.id,
    });
    await lifecycles.afterCreate({ result: reply });
    expect(notificationRows(strapi).map((n) => n.recipient)).toEqual([{ id: USER.carol }]);
  });

  it("the author's own comment notifies nobody", async () => {
    const { strapi, announcement } = setup();
    const row = await comment(strapi, { author: USER.carol, targetDocumentId: announcement });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)).toEqual([]);
  });

  it("wiki-page comments and unresolvable targets notify nobody", async () => {
    const { strapi } = setup();
    const wiki = await comment(strapi, {
      author: USER.alice,
      targetType: "wiki-page",
      targetDocumentId: "k3v9q2m8x7c4b1n6p5z0r2t8",
    });
    await lifecycles.afterCreate({ result: wiki });
    const gone = await comment(strapi, {
      author: USER.alice,
      targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz",
    });
    await lifecycles.afterCreate({ result: gone });
    await lifecycles.afterCreate({ result: { id: 9999 } });
    expect(notificationRows(strapi)).toEqual([]);
  });

  it("falls back to 'Someone' and 'an announcement'", async () => {
    const { strapi } = setup();
    const { documentId } = strapi.seedDocument(
      ANNOUNCEMENT_UID,
      { title: null, author: { id: USER.carol } },
      { status: "published" },
    );
    for (const user of strapi.tables[USER_UID]) if (user.id === USER.alice) user.displayName = null;
    const row = await comment(strapi, { author: USER.alice, targetDocumentId: documentId });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)[0].title).toBe('Someone commented on "an announcement"');
  });

  it("truncates: a 250-character title fits varchar(255), quotes kept (FX18)", async () => {
    const { strapi } = setup();
    const { documentId } = strapi.seedDocument(
      ANNOUNCEMENT_UID,
      { title: "t".repeat(250), author: { id: USER.carol } },
      { status: "published" },
    );
    const row = await comment(strapi, { author: USER.alice, targetDocumentId: documentId });
    await lifecycles.afterCreate({ result: row });
    expect(notificationRows(strapi)[0].title).toBe(`Alice commented on "${"t".repeat(233)}…"`);
  });

  it("writes inside the comment's transaction and never throws", async () => {
    const { strapi, announcement } = setup();
    const row = await comment(strapi, { author: USER.alice, targetDocumentId: announcement });
    let before = -1;
    await strapi.db.transaction(async () => {
      await lifecycles.afterCreate({ result: row });
      before = notificationRows(strapi).length;
    });
    expect(before).toBe(1);

    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const q = query(uid);
      if (uid !== NOTIFICATION_UID) return q;
      return {
        ...q,
        create: async () => {
          throw new Error("insert failed");
        },
      };
    };
    await expect(lifecycles.afterCreate({ result: row })).resolves.toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[notifications] failed for comment: insert failed",
    );
  });
});
