import { describe, expect, it } from "vitest";

import { ORPHAN_MIN_AGE_MS, selectSweepCandidates, type SweepRow } from "./sweep-orphaned-uploads";

const NOW = new Date("2026-08-17T03:30:00+02:00");

/** An unattached, stamped, 48h-old file — sweepable unless overridden. */
function row(overrides: Partial<SweepRow> = {}): SweepRow {
  return {
    id: 1,
    createdAt: new Date(NOW.getTime() - 2 * ORPHAN_MIN_AGE_MS),
    providerMetadata: { uploadedBy: 7 },
    attached: false,
    ...overrides,
  };
}

describe("selectSweepCandidates", () => {
  it("sweeps an old, unattached, uploadedBy-stamped file", () => {
    expect(selectSweepCandidates([row()], NOW)).toEqual([1]);
  });

  it("returns an empty list for no rows", () => {
    expect(selectSweepCandidates([], NOW)).toEqual([]);
  });

  it("NEVER touches files without the uploadedBy stamp (avatars, documents)", () => {
    const adminUploads = [
      row({ id: 1, providerMetadata: null }),
      row({ id: 2, providerMetadata: {} }),
      row({ id: 3, providerMetadata: { public_id: "cloud-thing" } }),
      // A stamp that is not a number is no stamp.
      row({ id: 4, providerMetadata: { uploadedBy: "7" } }),
      row({ id: 5, providerMetadata: "not-an-object" }),
    ];
    expect(selectSweepCandidates(adminUploads, NOW)).toEqual([]);
  });

  it("never touches attached files, even old stamped ones", () => {
    expect(selectSweepCandidates([row({ attached: true })], NOW)).toEqual([]);
  });

  it("leaves files younger than 24h alone (in-flight two-step create)", () => {
    const oneHourOld = row({ createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    const justUnderCutoff = row({
      id: 2,
      createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS + 1000),
    });
    expect(selectSweepCandidates([oneHourOld, justUnderCutoff], NOW)).toEqual([]);
  });

  it("sweeps exactly at/after the 24h cutoff", () => {
    const atCutoff = row({ createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS) });
    expect(selectSweepCandidates([atCutoff], NOW)).toEqual([1]);
  });

  it("accepts string timestamps (DB drivers return strings)", () => {
    const stringDate = row({
      createdAt: new Date(NOW.getTime() - 2 * ORPHAN_MIN_AGE_MS).toISOString(),
    });
    expect(selectSweepCandidates([stringDate], NOW)).toEqual([1]);
  });

  it("fails closed on unparseable/missing createdAt", () => {
    expect(
      selectSweepCandidates(
        [row({ createdAt: "not a date" }), row({ id: 2, createdAt: null })],
        NOW,
      ),
    ).toEqual([]);
  });

  it("picks only the sweepable rows out of a mixed set", () => {
    const mixed = [
      row({ id: 1 }),
      row({ id: 2, attached: true }),
      row({ id: 3, providerMetadata: {} }),
      row({ id: 4, createdAt: new Date(NOW.getTime() - 1000) }),
      row({ id: 5 }),
    ];
    expect(selectSweepCandidates(mixed, NOW)).toEqual([1, 5]);
  });
});
