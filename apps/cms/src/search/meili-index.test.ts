import { describe, expect, it, vi } from "vitest";

import {
  SearchConfigError,
  parseMeiliConfig,
  rebuildSearchIndex,
  searchSignature,
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

/** A db stub: per uid published rows and the newest updatedAt. */
function db(
  rows: Record<string, Record<string, unknown>[]>,
  updatedAt = "2026-10-21T10:00:00.000Z",
) {
  const strapi = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      query: (uid: string) => ({
        findMany: vi.fn(async ({ where }: { where: unknown }) => {
          expect(where).toEqual({ publishedAt: { $notNull: true } });
          return rows[uid] ?? [];
        }),
        count: vi.fn(async () => (rows[uid] ?? []).length),
        findOne: vi.fn(async () => ({ updatedAt: new Date(updatedAt) })),
      }),
    },
  };
  return { strapi: strapi as unknown as SearchStrapi & typeof strapi };
}

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
      strapi,
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
      rebuildSearchIndex(strapi, parseMeiliConfig(ON)!, meili.fetchImpl, async () => {}),
    ).rejects.toThrow(/task \d+ failed/);
    expect(meili.calls).not.toContain("POST /swap-indexes");
  });
});

describe("syncSearchIndex", () => {
  it("does nothing while off", async () => {
    const { strapi } = db(ROWS);
    const meili = fakeMeili();
    await syncSearchIndex(strapi, {}, meili.fetchImpl, { signature: null });
    expect(meili.calls).toEqual([]);
  });

  it("rebuilds on the first run, skips an unchanged minute, rebuilds after a change", async () => {
    const state = { signature: null as string | null };
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
    const state = { signature: null as string | null };
    const { strapi } = db(ROWS);
    await syncSearchIndex(strapi, ON, fakeMeili().fetchImpl, state);
    const empty = fakeMeili({ liveExists: false });
    await syncSearchIndex(strapi, ON, empty.fetchImpl, state);
    expect(empty.calls).toContain("POST /swap-indexes");
  });
});

describe("searchSignature", () => {
  it("changes with the published count and the newest write", async () => {
    const a = await searchSignature(db(ROWS).strapi);
    expect(await searchSignature(db(ROWS).strapi)).toBe(a);
    expect(await searchSignature(db({ ...ROWS, "api::poll.poll": [] }).strapi)).not.toBe(a);
    expect(await searchSignature(db(ROWS, "2026-10-21T10:01:00.000Z").strapi)).not.toBe(a);
  });
});
