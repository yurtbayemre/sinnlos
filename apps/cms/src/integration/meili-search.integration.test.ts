import { describe, expect, it } from "vitest";
import { INDEXED_SEARCH_KINDS, searchIndexQueries } from "@sinnlos/domain";

import { loadSearchDocuments, rebuildSearchIndex, type SearchStrapi } from "../search/meili-index";

/**
 * The optional Meilisearch index against a real Meilisearch (v0.21): the
 * rebuild-and-swap with its settings, the kind filter of the web's
 * multi-search (searchIndexQueries, the same queries lib/search-meili.ts
 * sends), and the German corpus the settings were chosen on (deep-dive
 * plan-meilisearch.md). Runs when MEILI_TEST_URL and MEILI_TEST_MASTER_KEY
 * point at a Meilisearch (the CI integration job has a service for it).
 */

const URL = process.env.MEILI_TEST_URL ?? "";
const KEY = process.env.MEILI_TEST_MASTER_KEY ?? "";

const UID: Record<string, string> = {
  "api::announcement.announcement": "announcement",
  "api::wiki-page.wiki-page": "wiki-page",
  "api::document.document": "document",
  "api::event.event": "event",
  "api::poll.poll": "poll",
};

const doc = (documentId: string, title: string, description = "") => ({
  documentId,
  title,
  description,
});

const DOCUMENTS = [
  doc("urlaub", "Urlaubsantrag stellen", "So beantragst du deinen Urlaub im Portal."),
  doc("bv", "Betriebsvereinbarung Homeoffice", "Regeln für das mobile Arbeiten."),
  doc("mueller", "Ansprechpartner Herr Müller", "Lager und Versand."),
  doc("strasse", "Anfahrt Hauptstraße 5", "Parkplätze hinter dem Gebäude."),
  doc("schulungen", "Schulungen im November", "Termine der Pflichtschulungen."),
  doc("brand", "Brandschutzunterweisung 2026", "Fluchtwege, Feuerlöscher, Sammelplatz."),
  doc("safety", "Safety briefing for visitors", "English version of the site rules."),
  doc("stapler", "Gabelstapler Führerschein", "Fahrausweis für Flurförderzeuge."),
];

/** A database stub: the published rows per content type. */
function strapiWith(rows: Partial<Record<string, Record<string, unknown>[]>>): SearchStrapi {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: {
      query: (uid: string) => ({
        findMany: async () => rows[UID[uid]] ?? [],
      }),
    },
  } as unknown as SearchStrapi;
}

async function search(term: string): Promise<Record<string, string[]>> {
  const res = await fetch(`${URL}/multi-search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ queries: searchIndexQueries(term, 5) }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { hits: { documentId: string }[] }[] };
  return Object.fromEntries(
    INDEXED_SEARCH_KINDS.map((kind, i) => [kind, body.results[i].hits.map((h) => h.documentId)]),
  );
}

describe.skipIf(!URL || !KEY)("the Meilisearch index on a real Meilisearch", () => {
  const config = { url: URL.replace(/\/+$/, ""), key: KEY };

  it("rebuilds and swaps, and every query keeps to its kind", async () => {
    const count = await rebuildSearchIndex(
      await loadSearchDocuments(
        strapiWith({
          document: DOCUMENTS,
          poll: [{ documentId: "p1", question: "Urlaub im Sommer?" }],
        }),
      ),
      config,
    );
    expect(count).toBe(DOCUMENTS.length + 1);
    const hits = await search("Urlaub");
    expect(hits.document[0]).toBe("urlaub");
    expect(hits.poll).toEqual(["p1"]);
    expect(hits.announcement).toEqual([]);
  });

  it.each([
    ["Urlaubsantrag", "urlaub"],
    ["urlaubsantrg", "urlaub"],
    ["Urlaub Antrag", "urlaub"],
    ["Antrag", "urlaub"],
    ["Vereinbarung", "bv"],
    ["betriebsvereinbarnug", "bv"],
    ["Muller", "mueller"],
    ["Müller", "mueller"],
    ["Straße", "strasse"],
    ["Hauptstrasse", "strasse"],
    ["Schulung", "schulungen"],
    ["Pflichtschulung", "schulungen"],
    ["Brandshutz", "brand"],
    ["Unterweisung", "brand"],
    ["Feuerloescher", "brand"],
    ["visitor", "safety"],
    ["Stapler", "stapler"],
    ["Führerschein Stapler", "stapler"],
  ])("finds %s (German corpus of the settings)", async (term, documentId) => {
    await rebuildSearchIndex(
      await loadSearchDocuments(strapiWith({ document: DOCUMENTS })),
      config,
    );
    expect((await search(term)).document[0]).toBe(documentId);
  });

  it("drops what a rebuild no longer has", async () => {
    await rebuildSearchIndex(
      await loadSearchDocuments(strapiWith({ document: DOCUMENTS })),
      config,
    );
    expect((await search("Gabelstapler")).document).toContain("stapler");
    await rebuildSearchIndex(
      await loadSearchDocuments(
        strapiWith({ document: DOCUMENTS.filter((d) => d.documentId !== "stapler") }),
      ),
      config,
    );
    expect((await search("Gabelstapler")).document).not.toContain("stapler");
  });
});
