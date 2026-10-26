import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { syncSearchIndex, type SearchStrapi, type SyncState } from "../search/meili-index";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * v0.31 (#169): the search-index minute against the real Document Service
 * on both engines, with a fake Meilisearch. The probe moves on every
 * publication change (publish, a republish, unpublish, a module switched
 * off), so those rebuild within a minute; a draft save does not touch the
 * published rows, so that minute loads nothing and rebuilds nothing.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const ON = {
  MEILISEARCH_ENABLED: "1",
  MEILISEARCH_URL: "http://meili.test",
  MEILISEARCH_WRITE_KEY: "w",
};

/** A Meilisearch that accepts everything; records the swaps and the uploaded documents. */
function fakeMeili() {
  let live = false;
  let task = 0;
  const swaps: unknown[][] = [];
  let uploaded: unknown[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(ON.MEILISEARCH_URL, "");
    const method = init?.method ?? "GET";
    if (method === "GET" && path.startsWith("/tasks/")) return json(200, { status: "succeeded" });
    if (method === "GET") return live ? json(200, { uid: "sinnlos_search" }) : json(404, {});
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "POST" && path === "/indexes" && body?.uid === "sinnlos_search") live = true;
    // A rebuild of an empty set uploads nothing: each build starts empty.
    if (method === "POST" && path === "/indexes" && body?.uid !== "sinnlos_search") uploaded = [];
    if (method === "POST" && path.endsWith("/documents")) uploaded = body;
    if (method === "POST" && path === "/swap-indexes") swaps.push(uploaded);
    return json(202, { taskUid: ++task });
  }) as typeof fetch;
  return { fetchImpl, swaps };
}

describe.each(testEngines())("the search-index minute with the probe (v0.31) on %s", (engine) => {
  let t: TestStrapi;
  const meili = fakeMeili();
  const state: SyncState = { signature: null, probe: null, checkedAt: 0 };
  let now = Date.parse("2026-10-26T10:00:00.000Z");
  let documentId = "";

  const minute = async (env: Record<string, string> = ON) => {
    now += 60_000;
    const before = meili.swaps.length;
    await syncSearchIndex(t.strapi as unknown as SearchStrapi, env, meili.fetchImpl, state, now);
    return meili.swaps.length > before;
  };
  const indexed = () =>
    (
      meili.swaps[meili.swaps.length - 1] as { documentId: string; text: string; kind: string }[]
    ).filter((document) => document.kind === "announcement");
  const announcements = () => t.strapi.documents(ANNOUNCEMENT);

  beforeAll(async () => {
    t = await createTestStrapi({ engine, fixtures: false });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("rebuilds on the first minute, then not while nothing changed", async () => {
    expect(await minute()).toBe(true);
    expect(await minute()).toBe(false);
  });

  it("rebuilds after a publish", async () => {
    documentId = (
      await announcements().create({ data: { title: "Kantine", body: "Neu", audience: "all" } })
    ).documentId;
    expect(await minute()).toBe(false); // a draft is not indexed
    await announcements().publish({ documentId });
    expect(await minute()).toBe(true);
    expect(indexed().map((document) => document.text)).toEqual(["Neu"]);
  });

  it("leaves a draft save alone, and rebuilds when it is published", async () => {
    await announcements().update({ documentId, data: { body: "Neu ab Montag" } });
    expect(await minute()).toBe(false);
    await announcements().publish({ documentId });
    expect(await minute()).toBe(true);
    expect(indexed().map((document) => document.text)).toEqual(["Neu ab Montag"]);
    // A republish of the same draft: a new published row moves the probe
    // (a full check), the content is the same (no rebuild).
    const probe = state.probe;
    await announcements().publish({ documentId });
    expect(await minute()).toBe(false);
    expect(state.probe).not.toBe(probe);
  });

  it("rebuilds after an unpublish", async () => {
    await announcements().unpublish({ documentId });
    expect(await minute()).toBe(true);
    expect(indexed()).toEqual([]);
  });

  it("rebuilds when a module with indexed content is switched off", async () => {
    const events = t.strapi.documents("api::event.event");
    const event = await events.create({
      data: { title: "Sommerfest", start: "2026-07-01T16:00:00.000Z" },
    });
    await events.publish({ documentId: event.documentId });
    expect(await minute()).toBe(true);
    const kinds = () =>
      (meili.swaps[meili.swaps.length - 1] as { kind: string }[]).map((d) => d.kind);
    expect(kinds()).toContain("event");
    expect(await minute({ ...ON, FEATURES_OFF: "events" })).toBe(true);
    expect(kinds()).not.toContain("event");
  });
});
