import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import { withDistinct } from "./distinct-stub.test.helper";
import {
  pruneAcknowledgements,
  targetsByType,
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

describe("targetsByType (pure)", () => {
  it("groups the checkable targets and drops what names no checkable document", () => {
    expect(
      targetsByType([
        { targetType: "announcement", targetDocumentId: "a1" },
        { targetType: "document", targetDocumentId: "d1" },
        { targetType: "announcement", targetDocumentId: "a2" },
        { targetType: "wiki", targetDocumentId: "w1" },
        { targetType: "announcement", targetDocumentId: "" },
        { targetType: null, targetDocumentId: "a3" },
        { targetType: "document" },
      ]),
    ).toEqual(
      new Map([
        ["announcement", ["a1", "a2"]],
        ["document", ["d1"]],
      ]),
    );
  });
});

describe("pruneAcknowledgements", () => {
  function stub(acks: number, live: boolean) {
    return withDistinct(
      createStrapiStub({
        tables: {
          [ACK]: Array.from({ length: acks }, (_, i) => ({
            id: i + 1,
            targetType: i % 2 === 0 ? "announcement" : "document",
            targetDocumentId: i % 2 === 0 ? "ann1" : `doc${i}`,
          })),
          [ANNOUNCEMENT]: live ? [{ id: 1, documentId: "ann1", publishedAt: null }] : [],
          [DOCUMENT]: [],
        },
      }),
      { [ACK]: "acknowledgements" },
    );
  }

  it("deletes the orphans, logs once, and finds nothing the next night", async () => {
    const total = 1203;
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
