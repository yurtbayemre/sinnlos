/**
 * Wiki revision snapshot (S08 characterisation, §5.23): beforeUpdate writes
 * the PREVIOUS body as a wiki-revision when the update carries a changed
 * body over a non-empty one. The editor comes from wikiEditContext (the
 * REST controller's AsyncLocalStorage bridge), falling back to the payload's
 * and then the stored lastEditor. The INSERT runs inside the page update's
 * transaction (atomic with it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { USER, createOrgStub } from "../../../../test/org-fixtures.test.helper";
import type { StrapiStub } from "../../../../test/strapi-stub.test.helper";
import { wikiEditContext } from "../../../../utils/wiki-edit-context";
import lifecycles from "./lifecycles";

const PAGE_UID = "api::wiki-page.wiki-page";
const REVISION_UID = "api::wiki-revision.wiki-revision";
const PAGE_ID = 40;

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(page: Record<string, unknown> = {}) {
  const strapi = createOrgStub({
    extraTables: {
      [PAGE_UID]: [
        {
          id: PAGE_ID,
          documentId: "w0000000000000000000000a",
          title: "Onboarding",
          body: "Old body",
          lastEditor: { id: USER.bob },
          publishedAt: null,
          ...page,
        },
      ],
    },
  });
  vi.stubGlobal("strapi", strapi);
  return strapi;
}

const revisions = (strapi: StrapiStub) => strapi.tables[REVISION_UID] ?? [];

const update = (data: Record<string, unknown>, where: Record<string, unknown> = { id: PAGE_ID }) =>
  lifecycles.beforeUpdate({ params: { where, data } });

describe("wiki-page beforeUpdate", () => {
  it("snapshots the previous body with the controller's editor and summary", async () => {
    const strapi = setup();
    await wikiEditContext.run({ editorId: USER.alice, revisionSummary: "typo" }, () =>
      update({ body: "New body", lastEditor: USER.carol }),
    );
    expect(revisions(strapi)).toHaveLength(1);
    expect(revisions(strapi)[0]).toMatchObject({
      page: { id: PAGE_ID },
      body: "Old body",
      summary: "typo",
      editor: { id: USER.alice },
    });
    expect(typeof revisions(strapi)[0].publishedAt).not.toBe("undefined");
  });

  it("without a controller context: the payload's lastEditor, in every relation shape", async () => {
    for (const lastEditor of [USER.carol, { id: USER.carol }, { set: [{ id: USER.carol }] }, { connect: [{ id: USER.carol }] }]) {
      const strapi = setup();
      await update({ body: "New body", lastEditor, revisionSummary: "from the payload" });
      expect(revisions(strapi)[0]).toMatchObject({
        editor: { id: USER.carol },
        summary: "from the payload",
      });
    }
  });

  it("then the stored lastEditor, and null when nothing is known", async () => {
    const stored = setup();
    await update({ body: "New body" });
    expect(revisions(stored)[0]).toMatchObject({ editor: { id: USER.bob }, summary: null });

    const unknown = setup({ lastEditor: null });
    await update({ body: "New body", lastEditor: "not-an-id" });
    expect(revisions(unknown)[0]).toMatchObject({ editor: null });
  });

  it("writes nothing without a body change, a previous body or a where id", async () => {
    const strapi = setup();
    await update({ title: "Renamed" });
    await update({ body: "Old body" });
    await update({ body: "New body" }, {});
    await update({ body: "New body" }, { id: 999 });
    expect(revisions(strapi)).toEqual([]);

    const empty = setup({ body: "" });
    await update({ body: "First body" });
    expect(revisions(empty)).toEqual([]);
  });

  it("writes inside the update's transaction, before the commit", async () => {
    const strapi = setup();
    let before = -1;
    await strapi.db.transaction(async () => {
      await update({ body: "New body" });
      before = revisions(strapi).length;
    });
    expect(before).toBe(1);
  });

  it("a failing snapshot fails the update (no catch)", async () => {
    const strapi = setup();
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const q = query(uid);
      if (uid !== REVISION_UID) return q;
      return {
        ...q,
        create: async () => {
          throw new Error("insert failed");
        },
      };
    };
    await expect(update({ body: "New body" })).rejects.toThrow("insert failed");
  });
});
