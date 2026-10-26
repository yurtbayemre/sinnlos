import { describe, expect, it, vi } from "vitest";

import {
  FULL_CHECK_MS,
  SearchConfigError,
  parseMeiliConfig,
  loadSearchDocuments,
  rebuildSearchIndex,
  searchFingerprint,
  searchProbe,
  searchStatusLine,
  syncSearchIndex,
  toSearchDocument,
  type SearchStrapi,
} from "./meili-index";
import { cronRegistry } from "../cron/registry";

/**
 * The optional Meilisearch index (v0.21): the switch, the projection
 * (published content, no access or contact fields), the signature, and the
 * rebuild-and-swap against a fake Meilisearch that records every call.
 * The real HTTP contract runs in integration/meili-search.integration.test.ts.
 */

const ON = {
  MEILISEARCH_ENABLED: "1",
  MEILISEARCH_URL: "http://sinnlos-meili:7700/",
  MEILISEARCH_WRITE_KEY: "w",
};

describe("the switch", () => {
  it("is off unless MEILISEARCH_ENABLED is exactly 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(parseMeiliConfig({ ...ON, MEILISEARCH_ENABLED: value }), String(value)).toBeNull();
    }
    expect(searchStatusLine(null)).toBe("[search] meilisearch disabled");
  });

  it("needs the URL and the write key when on, naming only the variables", () => {
    expect(parseMeiliConfig(ON)).toEqual({ url: "http://sinnlos-meili:7700", key: "w" });
    expect(() => parseMeiliConfig({ MEILISEARCH_ENABLED: "1" })).toThrow(
      new SearchConfigError(
        "[search] MEILISEARCH_ENABLED=1 needs MEILISEARCH_URL and MEILISEARCH_WRITE_KEY",
      ),
    );
    expect(() => parseMeiliConfig({ ...ON, MEILISEARCH_URL: "sinnlos-meili:7700" })).toThrow(
      /must be an http\(s\) URL/,
    );
    expect(searchStatusLine(parseMeiliConfig(ON))).toBe(
      "[search] meilisearch enabled url=http://sinnlos-meili:7700",
    );
  });

  it("registers the search-index cron only when on", () => {
    const names = (env: Record<string, string>) =>
      cronRegistry("Europe/Berlin", env).map((t) => t.name);
    expect(names({})).not.toContain("search-index");
    expect(names(ON)).toContain("search-index");
    expect(cronRegistry("Europe/Berlin", ON).find((t) => t.name === "search-index")?.rule).toBe(
      "* * * * *",
    );
  });
});

describe("toSearchDocument", () => {
  it("maps title and text fields per kind, keyed by documentId", () => {
    expect(
      toSearchDocument("wiki-page", {
        documentId: "w1",
        title: " Brandschutz ",
        summary: "Kurz",
        body: "Fluchtwege",
        space: { visibility: "department" },
      }),
    ).toEqual({
      id: "wiki-page_w1",
      kind: "wiki-page",
      documentId: "w1",
      title: "Brandschutz",
      text: "Kurz\n\nFluchtwege",
    });
    expect(toSearchDocument("poll", { documentId: "p1", question: "Pizza?" })).toEqual({
      id: "poll_p1",
      kind: "poll",
      documentId: "p1",
      title: "Pizza?",
      text: "",
    });
  });

  it("skips a row without documentId or title", () => {
    expect(toSearchDocument("announcement", { title: "x" })).toBeNull();
    expect(toSearchDocument("announcement", { documentId: "a", title: "  " })).toBeNull();
  });
});

/**
 * A db stub: per uid published rows and the newest updatedAt. The probe's
 * newest id and publishedAt are the rows' own (an id defaults to the row's
 * position); `loads` counts the content reads (loadSearchDocuments).
 */
function db(
  rows: Record<string, Record<string, unknown>[]>,
  updatedAt = "2026-10-21T10:00:00.000Z",
) {
  let loads = 0;
  const strapi = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: (uid: string) => ({
        findMany: vi.fn(async ({ where }: { where: unknown }) => {
          expect(where).toEqual({ publishedAt: { $notNull: true } });
          loads += 1;
          return rows[uid] ?? [];
        }),
        count: vi.fn(async ({ where }: { where: unknown }) => {
          expect(where).toEqual({ publishedAt: { $notNull: true } });
          return (rows[uid] ?? []).length;
        }),
        findOne: vi.fn(
          async ({
            select: [field],
            where,
            orderBy,
          }: {
            select: string[];
            where: unknown;
            orderBy: unknown;
          }) => {
            // The newest published row with a value: a NULL never wins (Postgres
            // sorts NULLS FIRST in a descending order).
            expect(where).toEqual({ publishedAt: { $notNull: true }, [field]: { $notNull: true } });
            expect(orderBy).toEqual({ [field]: "desc" });
            const list = rows[uid] ?? [];
            if (list.length === 0) return null;
            if (field === "updatedAt") return { updatedAt: new Date(updatedAt) };
            const values = list.map(
              (row, i) => row[field] ?? (field === "id" ? i + 1 : "2026-10-21T09:00:00.000Z"),
            ) as (number | string)[];
            const sorted = values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            return { [field]: sorted[sorted.length - 1] };
          },
        ),
      }),
    },
  };
  return {
    strapi: strapi as unknown as SearchStrapi & typeof strapi,
    loads: () => loads,
  };
}

const fresh = () => ({
  signature: null as string | null,
  probe: null as string | null,
  checkedAt: 0,
});

/** A fake Meilisearch: records calls, enqueues tasks that succeed (or fail when told). */
function fakeMeili(options: { liveExists?: boolean; failTask?: string } = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  let liveExists = options.liveExists ?? false;
  let buildExists = false;
  let task = 0;
  const tasks = new Map<number, string>();
  const failed = new Map<number, string>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("http://sinnlos-meili:7700", "");
    const method = init?.method ?? "GET";
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer w");
    if (method === "GET" && path.startsWith("/tasks/")) {
      const uid = Number(path.split("/")[2]);
      if (failed.has(uid)) return json(200, { status: "failed", error: { code: failed.get(uid) } });
      return json(200, { status: tasks.get(uid) === options.failTask ? "failed" : "succeeded" });
    }
    calls.push(`${method} ${path}`);
    if (init?.body) bodies[`${method} ${path}`] = JSON.parse(String(init.body));
    if (method === "GET" && path === "/indexes/sinnlos_search") {
      return liveExists ? json(200, { uid: "sinnlos_search" }) : json(404, {});
    }
    if (
      method === "POST" &&
      path === "/indexes" &&
      (JSON.parse(String(init?.body)) as { uid: string }).uid === "sinnlos_search"
    ) {
      liveExists = true;
    }
    tasks.set(++task, `${method} ${path}`);
    if (method === "POST" && path === "/indexes" && String(init?.body).includes("_build")) {
      buildExists = true;
    }
    if (method === "DELETE" && path === "/indexes/sinnlos_search_build") {
      // Like Meilisearch: accepted, then the task fails when the index is not there.
      if (!buildExists) failed.set(task, "index_not_found");
      buildExists = false;
    }
    return json(202, { taskUid: task });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, bodies };
}

const ROWS = {
  "api::announcement.announcement": [{ documentId: "a1", title: "Kantine", body: "Neu" }],
  "api::poll.poll": [{ documentId: "p1", question: "Pizza?" }],
};

describe("rebuildSearchIndex", () => {
  it("fills the build index and swaps it in, creating the live index the first time", async () => {
    const { strapi } = db(ROWS);
    const meili = fakeMeili();
    const count = await rebuildSearchIndex(
      await loadSearchDocuments(strapi),
      parseMeiliConfig(ON)!,
      meili.fetchImpl,
      async () => {},
    );
    expect(count).toBe(2);
    expect(meili.calls).toEqual([
      "DELETE /indexes/sinnlos_search_build",
      "POST /indexes",
      "PATCH /indexes/sinnlos_search_build/settings",
      "POST /indexes/sinnlos_search_build/documents",
      "GET /indexes/sinnlos_search",
      "POST /indexes",
      "POST /swap-indexes",
      "DELETE /indexes/sinnlos_search_build",
    ]);
    expect(meili.bodies["POST /indexes/sinnlos_search_build/documents"]).toEqual([
      {
        id: "announcement_a1",
        kind: "announcement",
        documentId: "a1",
        title: "Kantine",
        text: "Neu",
      },
      { id: "poll_p1", kind: "poll", documentId: "p1", title: "Pizza?", text: "" },
    ]);
    expect(meili.bodies["PATCH /indexes/sinnlos_search_build/settings"]).toEqual({
      searchableAttributes: ["title", "text"],
      filterableAttributes: ["kind"],
      localizedAttributes: [{ attributePatterns: ["*"], locales: ["deu"] }],
    });
  });

  it("stops before the swap when a task fails, leaving the live index as it was", async () => {
    const { strapi } = db(ROWS);
    const meili = fakeMeili({
      liveExists: true,
      failTask: "POST /indexes/sinnlos_search_build/documents",
    });
    await expect(
      rebuildSearchIndex(
        await loadSearchDocuments(strapi),
        parseMeiliConfig(ON)!,
        meili.fetchImpl,
        async () => {},
      ),
    ).rejects.toThrow(/task \d+ failed/);
    expect(meili.calls).not.toContain("POST /swap-indexes");
  });
});

describe("syncSearchIndex", () => {
  it("does nothing while off", async () => {
    const { strapi } = db(ROWS);
    const meili = fakeMeili();
    await syncSearchIndex(strapi, {}, meili.fetchImpl, fresh());
    expect(meili.calls).toEqual([]);
  });

  it("rebuilds on the first run, skips an unchanged minute, rebuilds after a change", async () => {
    const state = fresh();
    const first = db(ROWS);
    const meili = fakeMeili();
    await syncSearchIndex(first.strapi, ON, meili.fetchImpl, state);
    expect(meili.calls).toContain("POST /swap-indexes");
    expect(first.strapi.log.info).toHaveBeenCalledWith("[search] index rebuilt: 2 document(s)");

    meili.calls.length = 0;
    await syncSearchIndex(first.strapi, ON, meili.fetchImpl, state);
    expect(meili.calls).toEqual(["GET /indexes/sinnlos_search"]);

    const changed = db({ ...ROWS, "api::poll.poll": [] });
    await syncSearchIndex(changed.strapi, ON, meili.fetchImpl, state);
    expect(meili.calls).toContain("POST /swap-indexes");
  });

  it("rebuilds an unchanged database when the live index is gone (a new Meilisearch volume)", async () => {
    const state = fresh();
    const { strapi } = db(ROWS);
    await syncSearchIndex(strapi, ON, fakeMeili().fetchImpl, state);
    const empty = fakeMeili({ liveExists: false });
    await syncSearchIndex(strapi, ON, empty.fetchImpl, state);
    expect(empty.calls).toContain("POST /swap-indexes");
  });
});

describe("syncSearchIndex with the probe (v0.31, #169)", () => {
  const T0 = Date.parse("2026-10-26T10:00:00.000Z");
  const MINUTE = 60_000;

  it("loads no content while the probe stands, and checks in full once FULL_CHECK_MS passed", async () => {
    const state = fresh();
    const store = db(ROWS);
    const meili = fakeMeili();
    await syncSearchIndex(store.strapi, ON, meili.fetchImpl, state, T0);
    const loads = store.loads();
    meili.calls.length = 0;
    for (let minute = 1; minute < FULL_CHECK_MS / MINUTE; minute++) {
      await syncSearchIndex(store.strapi, ON, meili.fetchImpl, state, T0 + minute * MINUTE);
    }
    expect(store.loads()).toBe(loads);
    expect(new Set(meili.calls)).toEqual(new Set(["GET /indexes/sinnlos_search"]));
    // Sixty minutes on: a full check, and no rebuild for the same content.
    await syncSearchIndex(store.strapi, ON, meili.fetchImpl, state, T0 + FULL_CHECK_MS);
    expect(store.loads()).toBeGreaterThan(loads);
    expect(meili.calls).not.toContain("POST /swap-indexes");
    expect(state.checkedAt).toBe(T0 + FULL_CHECK_MS);
  });

  it("picks up a text change the probe cannot see at the hourly full check", async () => {
    const state = fresh();
    const meili = fakeMeili();
    await syncSearchIndex(db(ROWS).strapi, ON, meili.fetchImpl, state, T0);
    // A raw write: new body, same rows, ids, count and timestamps.
    const raw = db({
      ...ROWS,
      "api::announcement.announcement": [{ documentId: "a1", title: "Kantine", body: "Zu" }],
    });
    meili.calls.length = 0;
    await syncSearchIndex(raw.strapi, ON, meili.fetchImpl, state, T0 + MINUTE);
    expect(raw.loads()).toBe(0);
    await syncSearchIndex(raw.strapi, ON, meili.fetchImpl, state, T0 + FULL_CHECK_MS);
    expect(meili.calls).toContain("POST /swap-indexes");
  });

  it("checks in full when the probe moved, and rebuilds only when the content changed", async () => {
    const state = fresh();
    const meili = fakeMeili();
    await syncSearchIndex(db(ROWS).strapi, ON, meili.fetchImpl, state, T0);
    // A republish of the same text: a new published row (id) and publishedAt.
    const republished = db({
      ...ROWS,
      "api::announcement.announcement": [
        { id: 5, documentId: "a1", title: "Kantine", body: "Neu", publishedAt: "2026-10-26" },
      ],
    });
    meili.calls.length = 0;
    await syncSearchIndex(republished.strapi, ON, meili.fetchImpl, state, T0 + MINUTE);
    expect(republished.loads()).toBeGreaterThan(0);
    expect(meili.calls).not.toContain("POST /swap-indexes");
    // A module switched off changes the kinds: a full check and a rebuild.
    await syncSearchIndex(
      republished.strapi,
      { ...ON, FEATURES_OFF: "polls" },
      meili.fetchImpl,
      state,
      T0 + 2 * MINUTE,
    );
    expect(meili.calls).toContain("POST /swap-indexes");
  });

  it("advances nothing on a failed rebuild, so the next minute retries", async () => {
    const state = fresh();
    const store = db(ROWS);
    await expect(
      syncSearchIndex(
        store.strapi,
        ON,
        fakeMeili({ failTask: "POST /swap-indexes" }).fetchImpl,
        state,
        T0,
      ),
    ).rejects.toThrow(/task \d+ failed/);
    expect(state).toEqual(fresh());
    const meili = fakeMeili({ liveExists: true });
    await syncSearchIndex(store.strapi, ON, meili.fetchImpl, state, T0 + MINUTE);
    expect(meili.calls).toContain("POST /swap-indexes");
    expect(state.checkedAt).toBe(T0 + MINUTE);
  });
});

describe("searchProbe", () => {
  it("names each enabled kind with its count and newest id, updatedAt and publishedAt", async () => {
    const probe = JSON.parse(await searchProbe(db(ROWS).strapi, {}));
    expect(probe).toEqual([
      ["announcement", 1, 1, "2026-10-21T10:00:00.000Z", "2026-10-21T09:00:00.000Z"],
      ["wiki-page", 0, null, null, null],
      ["document", 0, null, null, null],
      ["event", 0, null, null, null],
      ["poll", 1, 1, "2026-10-21T10:00:00.000Z", "2026-10-21T09:00:00.000Z"],
    ]);
    const off = JSON.parse(await searchProbe(db(ROWS).strapi, { FEATURES_OFF: "polls,events" }));
    expect(off.map((part: unknown[]) => part[0])).toEqual([
      "announcement",
      "wiki-page",
      "document",
    ]);
  });
});

describe("searchFingerprint", () => {
  it("changes with published content only, whatever the timestamps or the row order say", async () => {
    const a = searchFingerprint(await loadSearchDocuments(db(ROWS).strapi));
    // Same content, another newest updatedAt (a draft save): unchanged.
    expect(
      searchFingerprint(await loadSearchDocuments(db(ROWS, "2026-10-21T11:00:00.000Z").strapi)),
    ).toBe(a);
    // Same rows, another database order: unchanged.
    const reversed = {
      "api::announcement.announcement": [
        { documentId: "a2", title: "Zweite" },
        ...ROWS["api::announcement.announcement"],
      ],
    };
    const forward = {
      "api::announcement.announcement": [
        ...ROWS["api::announcement.announcement"],
        { documentId: "a2", title: "Zweite" },
      ],
    };
    expect(searchFingerprint(await loadSearchDocuments(db(reversed).strapi))).toBe(
      searchFingerprint(await loadSearchDocuments(db(forward).strapi)),
    );
    // A republish with the draft's updatedAt but new text (Codex review): changed.
    const republished = {
      ...ROWS,
      "api::announcement.announcement": [
        { documentId: "a1", title: "Kantine", body: "Neu ab Montag" },
      ],
    };
    expect(searchFingerprint(await loadSearchDocuments(db(republished).strapi))).not.toBe(a);
  });
});

describe("loadSearchDocuments with a module off (FEATURES_OFF, v0.28)", () => {
  it("leaves the kinds of an off module out, so the next rebuild drops them", async () => {
    const kinds = async (env: Record<string, string>) =>
      (await loadSearchDocuments(db(ROWS).strapi, env)).map((document) => document.kind);
    expect(await kinds({})).toEqual(["announcement", "poll"]);
    expect(await kinds({ FEATURES_OFF: "polls" })).toEqual(["announcement"]);
  });
});
