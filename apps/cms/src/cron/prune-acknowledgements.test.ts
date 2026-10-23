import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import {
  ACK_PRUNE_BATCH,
  orphanedAcknowledgements,
  pruneAcknowledgements,
  type AckJanitorStrapi,
} from "./prune-acknowledgements";

/**
 * Read confirmations (v0.28, owner decision 2026-10-23): deleted once their
 * document is gone in every state, never by age. The user link cascade is
 * pinned on both engines in integration/retention-v028.integration.test.ts.
 */

const ACK = "api::acknowledgement.acknowledgement";
const ANNOUNCEMENT = "api::announcement.announcement";
const DOCUMENT = "api::document.document";

describe("orphanedAcknowledgements (pure)", () => {
  const existing = new Map([
    [ANNOUNCEMENT, new Set(["ann-live"])],
    [DOCUMENT, new Set(["doc-live"])],
  ]);

  it("names the confirmations whose document is gone", () => {
    expect(
      orphanedAcknowledgements(
        [
          { id: 1, targetType: "announcement", targetDocumentId: "ann-live" },
          { id: 2, targetType: "announcement", targetDocumentId: "ann-gone" },
          { id: 3, targetType: "document", targetDocumentId: "doc-live" },
          { id: 4, targetType: "document", targetDocumentId: "doc-gone" },
        ],
        existing,
      ),
    ).toEqual([2, 4]);
  });

  it("keeps what names no checkable document", () => {
    expect(
      orphanedAcknowledgements(
        [
          { id: 1, targetType: "wiki", targetDocumentId: "w1" },
          { id: 2, targetType: "announcement", targetDocumentId: "" },
          { id: 3, targetType: null, targetDocumentId: "ann-gone" },
          { id: 4, targetType: "announcement" },
        ],
        existing,
      ),
    ).toEqual([]);
    // No lookup for the type: nothing is known, nothing goes.
    expect(
      orphanedAcknowledgements(
        [{ id: 1, targetType: "document", targetDocumentId: "d" }],
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe("pruneAcknowledgements", () => {
  function stub(acks: number, live: boolean) {
    return createStrapiStub({
      tables: {
        [ACK]: Array.from({ length: acks }, (_, i) => ({
          id: i + 1,
          targetType: i % 2 === 0 ? "announcement" : "document",
          targetDocumentId: i % 2 === 0 ? "ann1" : `doc${i}`,
        })),
        [ANNOUNCEMENT]: live ? [{ id: 1, documentId: "ann1", publishedAt: null }] : [],
        [DOCUMENT]: [],
      },
    });
  }

  it("deletes the orphans page by page, logs once, and finds nothing the next night", async () => {
    const total = ACK_PRUNE_BATCH * 2 + 3;
    const strapi = stub(total, true);
    const orphans = Math.floor(total / 2);
    await expect(pruneAcknowledgements(strapi as unknown as AckJanitorStrapi)).resolves.toBe(
      orphans,
    );
    expect(strapi.tables[ACK]).toHaveLength(total - orphans);
    expect(strapi.tables[ACK].every((row) => row.targetType === "announcement")).toBe(true);
    expect(strapi.log.info.mock.calls).toEqual([
      [`[ack-janitor] pruned ${orphans} acknowledgement(s) of documents that no longer exist`],
    ]);
    strapi.log.info.mockClear();
    await expect(pruneAcknowledgements(strapi as unknown as AckJanitorStrapi)).resolves.toBe(0);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });

  it("counts a draft-only document as existing", async () => {
    const strapi = stub(1, true);
    await expect(pruneAcknowledgements(strapi as unknown as AckJanitorStrapi)).resolves.toBe(0);
    expect(strapi.tables[ACK]).toHaveLength(1);
  });
});
