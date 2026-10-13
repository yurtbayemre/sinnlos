import { afterEach, describe, expect, it, vi } from "vitest";

import auditLifecycles from "../api/audit-event/content-types/audit-event/lifecycles";
import {
  appContentType,
  openDocumentService,
  type OpenDocumentService,
} from "../test/document-service.test.helper";
import { AUDIT_EVENT_UID, recordAuditEvent, type AuditHost } from "../utils/audit";
import {
  AUDIT_PRUNE_BATCH,
  auditRetentionDays,
  pruneAuditEvents,
  type AuditJanitorStrapi,
} from "./prune-audit-events";

/** audit-janitor (decision 06 §H retention, LF07): AUDIT_RETENTION_DAYS, default 365. */

describe("auditRetentionDays", () => {
  it("defaults to 365 and reads whole days of at least 1", () => {
    expect(auditRetentionDays(undefined)).toBe(365);
    expect(auditRetentionDays("  ")).toBe(365);
    expect(auditRetentionDays("30")).toBe(30);
    expect(auditRetentionDays(" 1 ")).toBe(1);
  });

  it("refuses anything else (the run then deletes nothing)", () => {
    for (const value of ["0", "-5", "1.5", "30d", "abc", "1e3", "99999999999999999999"]) {
      expect(auditRetentionDays(value), value).toBeNull();
    }
  });
});

describe("pruneAuditEvents on the real query engine", () => {
  let open: OpenDocumentService;
  afterEach(async () => {
    await open?.close();
  });

  const NOW = new Date("2027-11-02T03:50:00.000Z");
  const DAY = 86_400_000;

  async function seeded(ages: number[]) {
    open = await openDocumentService([appContentType(AUDIT_EVENT_UID)]);
    (
      open.db as unknown as { lifecycles: { subscribe(subscriber: unknown): void } }
    ).lifecycles.subscribe({
      models: [AUDIT_EVENT_UID],
      ...auditLifecycles,
    });
    for (const [index, age] of ages.entries()) {
      await recordAuditEvent(open.strapi as unknown as AuditHost, {
        action: "update",
        targetUid: "api::announcement.announcement",
        targetDocumentId: `doc-${index}`,
        actorKind: "system",
        source: "system",
      });
      // Back-date through raw SQL (the lifecycle refuses updates by design).
      await open.db.connection.raw(
        "UPDATE audit_events SET created_at = ? WHERE target_document_id = ?",
        [NOW.getTime() - age * DAY, `doc-${index}`],
      );
    }
    const log = { info: vi.fn(), error: vi.fn() };
    const strapi = { db: open.db, log } as unknown as AuditJanitorStrapi;
    return { strapi, log };
  }

  const remaining = async () =>
    (await open.db.query(AUDIT_EVENT_UID).findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.targetDocumentId,
    );

  it("deletes rows created before the retention, under the janitor marker", async () => {
    const { strapi, log } = await seeded([400, 366, 365, 10]);
    expect(await pruneAuditEvents(strapi, NOW, {})).toBe(2);
    expect(await remaining()).toEqual(["doc-2", "doc-3"]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[audit-janitor\] pruned 2 audit event\(s\) created before 2026-11-02T03:50:00\.000Z \(AUDIT_RETENTION_DAYS=365\)$/,
      ),
    );
    // Nothing left to do: no line.
    log.info.mockClear();
    expect(await pruneAuditEvents(strapi, NOW, {})).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("follows AUDIT_RETENTION_DAYS", async () => {
    const { strapi } = await seeded([40, 20, 5]);
    expect(await pruneAuditEvents(strapi, NOW, { AUDIT_RETENTION_DAYS: "30" })).toBe(1);
    expect(await remaining()).toEqual(["doc-1", "doc-2"]);
  });

  it("an invalid AUDIT_RETENTION_DAYS deletes nothing and says so", async () => {
    const { strapi, log } = await seeded([4000]);
    expect(await pruneAuditEvents(strapi, NOW, { AUDIT_RETENTION_DAYS: "0" })).toBe(0);
    expect(await remaining()).toEqual(["doc-0"]);
    expect(log.error).toHaveBeenCalledWith(
      '[audit-janitor] AUDIT_RETENTION_DAYS="0" is not a whole number of days (at least 1); nothing was deleted',
    );
  });

  it("pages its deletes", () => {
    expect(AUDIT_PRUNE_BATCH).toBe(500);
  });
});
