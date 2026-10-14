import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteAuditContext } from "../utils/delete-audit";
import { TOMBSTONE_RETRY_MS } from "../utils/upload-orphans";
import {
  ORPHAN_MIN_AGE_MS,
  selectSweepCandidates,
  sweepOrphanedUploads,
  type SweepRow,
} from "./sweep-orphaned-uploads";

const mocks = vi.hoisted(() => ({
  claimAndRemove: vi.fn(async (..._args: unknown[]) => "removed"),
  linked: new Set<number>(),
  contexts: [] as unknown[],
}));

vi.mock("../utils/upload-orphans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/upload-orphans")>()),
  claimAndRemove: mocks.claimAndRemove,
  linkedFileIds: async (_strapi: unknown, ids: number[]) =>
    new Set(ids.filter((id) => mocks.linked.has(id))),
}));

afterEach(() => {
  mocks.claimAndRemove.mockReset().mockResolvedValue("removed");
  mocks.linked.clear();
  mocks.contexts.length = 0;
});

const NOW = new Date("2026-08-17T03:30:00+02:00");

/** A stamped, 48h-old file — a candidate unless overridden. */
function row(overrides: Partial<SweepRow> = {}): SweepRow {
  return {
    id: 1,
    createdAt: new Date(NOW.getTime() - 2 * ORPHAN_MIN_AGE_MS),
    providerMetadata: { uploadedBy: 7 },
    ...overrides,
  };
}

describe("selectSweepCandidates", () => {
  it("picks an old, uploadedBy-stamped file", () => {
    expect(selectSweepCandidates([row()], NOW)).toEqual([1]);
    expect(selectSweepCandidates([], NOW)).toEqual([]);
  });

  it("NEVER touches files without the uploadedBy stamp (avatars, panel documents)", () => {
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

  it("leaves files younger than 24h alone (in-flight two-step create)", () => {
    const oneHourOld = row({ createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    const justUnderCutoff = row({
      id: 2,
      createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS + 1000),
    });
    expect(selectSweepCandidates([oneHourOld, justUnderCutoff], NOW)).toEqual([]);
    const atCutoff = row({ createdAt: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS) });
    expect(selectSweepCandidates([atCutoff], NOW)).toEqual([1]);
  });

  it("accepts string timestamps and fails closed on unparseable ones", () => {
    const stringDate = row({
      createdAt: new Date(NOW.getTime() - 2 * ORPHAN_MIN_AGE_MS).toISOString(),
    });
    expect(selectSweepCandidates([stringDate], NOW)).toEqual([1]);
    expect(
      selectSweepCandidates(
        [row({ createdAt: "not a date" }), row({ id: 2, createdAt: null })],
        NOW,
      ),
    ).toEqual([]);
  });

  it("retries a stale reservation once it is 10 minutes old, whoever took it", () => {
    const tombstone = (ms: number, stamp = true) => ({
      ...(stamp ? { uploadedBy: 7 } : {}),
      removing: new Date(NOW.getTime() - ms).toISOString(),
    });
    expect(
      selectSweepCandidates(
        [
          row({
            id: 1,
            createdAt: new Date(NOW.getTime() - 1000),
            providerMetadata: tombstone(TOMBSTONE_RETRY_MS),
          }),
          row({ id: 2, providerMetadata: tombstone(TOMBSTONE_RETRY_MS - 1000) }),
          // A Media Library delete of an unstamped file that failed after its reservation.
          row({ id: 3, providerMetadata: tombstone(TOMBSTONE_RETRY_MS, false) }),
        ],
        NOW,
      ),
    ).toEqual([1, 3]);
  });

  it("pins the scope: document uploads of moderators and department heads are stamped like ad images", () => {
    // The wrapper stamps every content-API upload with the caller's id,
    // whatever the profile; the janitor does not look at the mime.
    const editorPdf = row({ id: 1, providerMetadata: { uploadedBy: 2 } });
    const headXlsx = row({ id: 2, providerMetadata: { uploadedBy: 3 } });
    expect(selectSweepCandidates([editorPdf, headXlsx], NOW)).toEqual([1, 2]);
  });
});

describe("sweepOrphanedUploads: every candidate through claimAndRemove, as cron", () => {
  function makeStrapi(rows: Array<Record<string, unknown>>) {
    const info: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["whereRaw", "where", "orderBy"]) builder[method] = () => builder;
    builder.select = async () => rows;
    return {
      strapi: {
        db: { getConnection: () => builder },
        log: { info: (m: string) => info.push(m), error: vi.fn() },
      },
      info,
    };
  }

  it("skips linked files and claims the rest with the janitor's options", async () => {
    mocks.claimAndRemove.mockImplementation(async () => {
      mocks.contexts.push(deleteAuditContext());
      return "removed";
    });
    mocks.linked.add(2);
    const old = new Date(NOW.getTime() - 2 * ORPHAN_MIN_AGE_MS).toISOString();
    const { strapi, info } = makeStrapi([
      { id: 1, created_at: old, provider_metadata: '{"uploadedBy":7}' },
      { id: 2, created_at: old, provider_metadata: { uploadedBy: 7 } },
      { id: 3, created_at: old, provider_metadata: "{broken" },
    ]);
    await sweepOrphanedUploads(strapi, NOW);
    expect(mocks.claimAndRemove.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [1, { minAgeMs: ORPHAN_MIN_AGE_MS, now: NOW }],
    ]);
    expect(mocks.contexts).toEqual([{ source: "cron" }]);
    expect(info).toEqual(["[uploads-janitor] swept 1 orphaned upload(s)"]);
  });
});
