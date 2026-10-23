import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_VALIDITY_MONTHS, type TrainingSnapshot } from "@sinnlos/domain";
import { describe, expect, it } from "vitest";

import {
  currentReceiptIds,
  isSameVersion,
  parseSnapshot,
  publicationStamp,
  receiptExpired,
  trainingEvidenceRetentionYears,
  trainingVersionOf,
  validityOf,
  type RetentionReceipt,
} from "./training-evidence";

/**
 * The pure rules of the training evidence (v0.28, plan-v028-rev3.md R2 and
 * rev3.1): the version token, the snapshot reader and the retention table.
 */

const ZONE = "Europe/Berlin";
const YEARS = 3;

function snapshot(overrides: Partial<TrainingSnapshot> = {}): TrainingSnapshot {
  return {
    v: 1,
    course: { documentId: "c", title: "Course", publishedAt: "2026-01-01T00:00:00.000Z" },
    lesson: { documentId: "l", title: "Lesson", publishedAt: "2026-01-01T00:00:00.000Z" },
    completionMode: "confirm",
    quizPassed: null,
    validUntil: null,
    learner: { displayName: "Ada", email: "ada@example.com" },
    ...overrides,
  };
}

const receipt = (
  snap: TrainingSnapshot | null,
  completedAt = "2020-03-10T09:00:00.000Z",
): RetentionReceipt => ({
  id: 1,
  completedAt,
  snapshot: snap,
});

const expired = (
  r: RetentionReceipt,
  context: { current?: boolean; anonymisedAt?: string | null; todayKey: string },
) =>
  receiptExpired(r, {
    current: context.current ?? false,
    anonymisedAt: context.anonymisedAt ?? null,
    todayKey: context.todayKey,
    years: YEARS,
    timeZone: ZONE,
  });

describe("the version token", () => {
  it("normalises stored instants of every engine to ISO", () => {
    expect(publicationStamp(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01T00:00:00.000Z");
    expect(publicationStamp("2026-09-01T02:00:00+02:00")).toBe("2026-09-01T00:00:00.000Z");
    expect(publicationStamp(Date.UTC(2026, 8, 1))).toBe("2026-09-01T00:00:00.000Z");
    for (const bad of [null, undefined, "", "2026-09-01", "garbage", {}, Number.NaN]) {
      expect(publicationStamp(bad), String(bad)).toBeNull();
    }
  });

  it("needs both stamps, and compares instants", () => {
    const lesson = {
      documentId: "l",
      title: "L",
      publishedAt: "2026-09-02T00:00:00.000Z",
      course: {
        documentId: "c",
        title: "C",
        completionMode: null,
        validityMonths: null,
        publishedAt: "2026-09-01T00:00:00.000Z",
      },
    };
    const version = trainingVersionOf(lesson)!;
    expect(version).toEqual({
      course: "2026-09-01T00:00:00.000Z",
      lesson: "2026-09-02T00:00:00.000Z",
    });
    expect(
      isSameVersion({ course: "2026-09-01T02:00:00+02:00", lesson: version.lesson }, version),
    ).toBe(true);
    expect(isSameVersion({ course: version.course }, version)).toBe(false);
    expect(isSameVersion(undefined, version)).toBe(false);
    expect(isSameVersion(version, null)).toBe(false);
    expect(trainingVersionOf({ ...lesson, publishedAt: null })).toBeNull();
  });
});

describe("the stored snapshot", () => {
  it("reads objects and strings, and nothing else", () => {
    const snap = snapshot({ quizPassed: true, validUntil: "2027-03-10" });
    expect(parseSnapshot(snap)).toEqual(snap);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
    expect(parseSnapshot({ ...snap, backfilled: true })).toEqual({ ...snap, backfilled: true });
    for (const bad of [null, "{", { v: 2 }, [], 1]) expect(parseSnapshot(bad)).toBeNull();
  });

  it("tells known validity, known no expiry and unknown apart", () => {
    expect(validityOf(snapshot({ validUntil: "2027-03-10" }))).toEqual({
      kind: "until",
      key: "2027-03-10",
    });
    expect(validityOf(snapshot())).toEqual({ kind: "noExpiry" });
    expect(validityOf(snapshot({ backfilled: true }))).toEqual({ kind: "unknown" });
    expect(validityOf(null)).toEqual({ kind: "unknown" });
  });
});

describe("TRAINING_EVIDENCE_RETENTION_YEARS", () => {
  it("is 3 unset or blank, a whole number from 1 to 30, and throws otherwise", () => {
    expect(trainingEvidenceRetentionYears({})).toBe(3);
    expect(trainingEvidenceRetentionYears({ TRAINING_EVIDENCE_RETENTION_YEARS: " " })).toBe(3);
    expect(trainingEvidenceRetentionYears({ TRAINING_EVIDENCE_RETENTION_YEARS: "10" })).toBe(10);
    for (const bad of ["0", "31", "2.5", "-1", "three"]) {
      expect(
        () => trainingEvidenceRetentionYears({ TRAINING_EVIDENCE_RETENTION_YEARS: bad }),
        bad,
      ).toThrow();
    }
  });
});

describe("the retention table (rev3.1)", () => {
  it("never deletes the newest receipt of an active person", () => {
    for (const snap of [
      snapshot({ validUntil: "2000-01-01" }),
      snapshot(),
      snapshot({ backfilled: true }),
      null,
    ]) {
      expect(expired(receipt(snap), { current: true, todayKey: "2099-01-01" })).toBe(false);
    }
  });

  it("deletes a superseded receipt with a known validUntil N years after it", () => {
    const r = receipt(snapshot({ validUntil: "2021-03-10" }));
    expect(expired(r, { todayKey: "2024-03-10" })).toBe(false);
    expect(expired(r, { todayKey: "2024-03-11" })).toBe(true);
  });

  it("keeps a superseded no-expiry receipt (no expiry → 12 months, then a renewal)", () => {
    expect(expired(receipt(snapshot()), { todayKey: "2099-01-01" })).toBe(false);
  });

  it("keeps a superseded receipt of unknown validity, and one without a snapshot", () => {
    expect(expired(receipt(snapshot({ backfilled: true })), { todayKey: "2099-01-01" })).toBe(
      false,
    );
    expect(expired(receipt(null), { todayKey: "2099-01-01" })).toBe(false);
  });

  it("after an anonymisation: the later of validUntil and the departure, plus N", () => {
    const anonymisedAt = "2026-10-23T10:00:00.000Z";
    const until = receipt(snapshot({ validUntil: "2027-06-01" }));
    expect(expired(until, { current: true, anonymisedAt, todayKey: "2030-06-01" })).toBe(false);
    expect(expired(until, { current: true, anonymisedAt, todayKey: "2030-06-02" })).toBe(true);
    const early = receipt(snapshot({ validUntil: "2022-01-01" }));
    expect(expired(early, { current: true, anonymisedAt, todayKey: "2029-10-23" })).toBe(false);
    expect(expired(early, { current: true, anonymisedAt, todayKey: "2029-10-24" })).toBe(true);
  });

  it("after an anonymisation: a no-expiry receipt goes N years after the departure", () => {
    const anonymisedAt = "2026-10-23T10:00:00.000Z";
    const r = receipt(snapshot());
    expect(expired(r, { anonymisedAt, todayKey: "2029-10-23" })).toBe(false);
    expect(expired(r, { anonymisedAt, todayKey: "2029-10-24" })).toBe(true);
  });

  it("after an anonymisation: unknown validity uses completedAt + 120 months as its bound", () => {
    expect(MAX_VALIDITY_MONTHS).toBe(120);
    const anonymisedAt = "2026-10-23T10:00:00.000Z";
    // Completed 2020-03-10: bound 2030-03-10, later than the departure.
    const r = receipt(snapshot({ backfilled: true }), "2020-03-10T09:00:00.000Z");
    expect(expired(r, { anonymisedAt, todayKey: "2033-03-10" })).toBe(false);
    expect(expired(r, { anonymisedAt, todayKey: "2033-03-11" })).toBe(true);
    // An unreadable completion keeps it.
    expect(expired({ ...r, completedAt: null }, { anonymisedAt, todayKey: "2099-01-01" })).toBe(
      false,
    );
  });

  it("the 120-month bound is the course schema's maximum", () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, "../api/course/content-types/course/schema.json"), "utf8"),
    );
    expect(schema.attributes.validityMonths.max).toBe(MAX_VALIDITY_MONTHS);
  });

  it("keeps a receipt whose departure is unreadable", () => {
    expect(expired(receipt(snapshot()), { anonymisedAt: "garbage", todayKey: "2099-01-01" })).toBe(
      false,
    );
  });
});

describe("the newest receipt per lesson", () => {
  it("is decided by completedAt, then id; unreadable instants count as oldest", () => {
    const ids = currentReceiptIds([
      { id: 1, lesson: "a", completedAt: "2026-01-01T00:00:00.000Z", snapshot: null },
      { id: 2, lesson: "a", completedAt: "2026-02-01T00:00:00.000Z", snapshot: null },
      { id: 3, lesson: "a", completedAt: "2026-02-01T00:00:00.000Z", snapshot: null },
      { id: 4, lesson: "b", completedAt: null, snapshot: null },
      { id: 5, lesson: "b", completedAt: "2025-01-01T00:00:00.000Z", snapshot: null },
    ]);
    expect([...ids].sort()).toEqual([3, 5]);
  });
});
