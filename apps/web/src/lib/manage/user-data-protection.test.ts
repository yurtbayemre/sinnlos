import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainingEvidenceRow } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { evidenceCsv } from "@/lib/training-report-csv";

/**
 * Data protection at /manage/users/[id] (v0.28, admin_role only):
 *   - the anonymisation's Server Actions: the preview, the run with the
 *     typed username, its 409/400 codes, the admin gate;
 *   - the two downloads: the export as JSON named by the username, the
 *     training evidence as CSV, both never cached, a cms 404 kept, any
 *     other failure a 502, nobody but an admin served;
 *   - the evidence CSV: German labels, unknown facts of a receipt from
 *     before v0.28 said as such.
 */
const strapi = vi.fn();
const refresh = vi.fn();
let viewer: Viewer;
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refresh() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
const { anonymiseUser, previewAnonymisation } = await import("./user-actions");
const { evidenceDownload, exportDownload, fileNamePart, userIdOf } =
  await import("./user-downloads");

const cmsError = (status: number, details = {}) =>
  new StrapiError(status, "Error", JSON.stringify({ error: { status, details } }));
const COUNTS = {
  deleted: {
    reactions: 1,
    pollVotes: 2,
    rsvps: 0,
    kudosReceived: 0,
    notifications: 5,
    acknowledgements: 1,
    classifieds: 0,
  },
  rewritten: { notifications: 2 },
  kept: {
    announcements: 0,
    wikiPages: 1,
    documents: 0,
    events: 0,
    polls: 0,
    comments: 3,
    kudosGiven: 0,
    dutyPlans: 0,
    kpis: 0,
    trainingReceipts: 4,
  },
};

beforeEach(() => {
  viewer = { id: 1, role: "admin_role", displayName: "Alex", department: null };
  strapi.mockReset();
  refresh.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("anonymisation actions (v0.28)", () => {
  it("previews with a GET and hands the counts on", async () => {
    const data = {
      id: 12,
      username: "casey",
      displayName: "Casey",
      blocked: true,
      anonymisedAt: null,
      counts: COUNTS,
    };
    strapi.mockResolvedValue({ data });
    await expect(previewAnonymisation(12)).resolves.toEqual({ ok: true, data });
    expect(strapi).toHaveBeenCalledWith("/api/user-management/12/anonymise");
  });

  it("runs with the trimmed username, refreshes, and hands the outcome on", async () => {
    const data = { id: 12, anonymisedAt: "2026-10-23T12:00:00.000Z", counts: COUNTS, avatar: null };
    strapi.mockResolvedValue({ data });
    await expect(anonymiseUser(12, " casey ")).resolves.toEqual({ ok: true, data });
    const [path, init] = strapi.mock.calls.at(-1)! as [string, { method: string; body: string }];
    expect(path).toBe("/api/user-management/12/anonymise");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ data: { confirm: "casey" } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not blocked", cmsError(409, { code: "notBlocked" }), "notBlocked"],
    ["already anonymised", cmsError(409, { code: "anonymised" }), "anonymised"],
    ["a wrong username", cmsError(400, { code: "confirm" }), "confirm"],
    ["another 409", cmsError(409, { code: "other" }), "failed"],
    ["a missing user", cmsError(404), "notFound"],
  ])("maps %s", async (_name, error, code) => {
    strapi.mockRejectedValue(error);
    await expect(anonymiseUser(12, "casey")).resolves.toEqual({ ok: false, code });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never asks the cms without a username, a valid id or an admin", async () => {
    for (const confirm of ["", "   ", 7, null, "x".repeat(256)]) {
      await expect(anonymiseUser(12, confirm)).resolves.toEqual({ ok: false, code: "confirm" });
    }
    await expect(anonymiseUser("12", "casey")).resolves.toEqual({ ok: false, code: "invalid" });
    viewer = { ...viewer, role: "editor" };
    await expect(anonymiseUser(12, "casey")).resolves.toEqual({ ok: false, code: "forbidden" });
    await expect(previewAnonymisation(12)).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(strapi).not.toHaveBeenCalled();
  });
});

describe("the downloads (v0.28)", () => {
  it("parses row ids and makes file-name parts safe", () => {
    expect(userIdOf("12")).toBe(12);
    for (const raw of ["0", "-1", "1.5", "abc", "12abc", "99999999999"])
      expect(userIdOf(raw)).toBeNull();
    expect(fileNamePart("casey.jones")).toBe("casey.jones");
    expect(fileNamePart('a"b/c\\d e')).toBe("a-b-c-d-e");
    expect(fileNamePart("..")).toBe("user");
  });

  it("downloads the export as JSON named by the username, never cached", async () => {
    strapi.mockResolvedValue({ meta: {}, account: { username: "casey.jones" }, content: {} });
    const res = await exportDownload("12");
    expect(strapi).toHaveBeenCalledWith("/api/user-management/12/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sinnlos-export-casey\.jones-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(JSON.parse(await res.text()).account.username).toBe("casey.jones");
  });

  it("downloads the evidence as CSV named by the id", async () => {
    strapi.mockResolvedValue({ data: { user: { id: 12, displayName: "Casey" }, rows: [] } });
    const res = await evidenceDownload("12");
    expect(strapi).toHaveBeenCalledWith("/api/user-management/12/training-evidence");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="sinnlos-nachweise-12-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the cms's 404, answers anything else with 502, and serves admins only", async () => {
    strapi.mockRejectedValue(cmsError(404));
    expect((await exportDownload("12")).status).toBe(404);
    strapi.mockRejectedValue(cmsError(500));
    expect((await evidenceDownload("12")).status).toBe(502);
    expect((await exportDownload("abc")).status).toBe(404);
    viewer = { ...viewer, role: "department_head" };
    strapi.mockReset();
    expect((await exportDownload("12")).status).toBe(403);
    expect((await evidenceDownload("12")).status).toBe(403);
    expect(strapi).not.toHaveBeenCalled();
  });
});

describe("evidenceCsv (v0.28)", () => {
  const row = (over: Partial<TrainingEvidenceRow> = {}): TrainingEvidenceRow => ({
    id: 1,
    completedAt: "2026-03-02T09:15:00.000Z",
    course: { documentId: "c1", title: "Brandschutz" },
    version: "2026-02-01T07:00:00.000Z",
    lesson: { documentId: "l1", title: "Fluchtwege" },
    completionMode: "quizGate",
    quiz: "passed",
    validUntil: "2027-03-02",
    validity: "until",
    backfilled: false,
    current: true,
    ...over,
  });

  it("writes one German row per receipt, unknown facts said as such", () => {
    const csv = evidenceCsv(
      [
        row(),
        row({
          id: 2,
          course: { documentId: null, title: "=Gelöschter Kurs" },
          version: null,
          completionMode: null,
          quiz: "unknown",
          validUntil: null,
          validity: "unknown",
          backfilled: true,
        }),
        row({
          id: 3,
          quiz: "none",
          completionMode: "confirm",
          validity: "noExpiry",
          validUntil: null,
        }),
      ],
      "Europe/Berlin",
    );
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n")).toEqual([
      "﻿Datum;Kurs;Version;Lektion;Abschlussart;Quiz;Gültig bis;Hinweis",
      "02.03.2026 10:15;Brandschutz;01.02.2026 08:00;Fluchtwege;Quiz;bestanden;02.03.2027;",
      "02.03.2026 10:15;'=Gelöschter Kurs;unbekannt;Fluchtwege;unbekannt;unbekannt;unbekannt;Stand unbekannt (vor v0.28)",
      "02.03.2026 10:15;Brandschutz;01.02.2026 08:00;Fluchtwege;Bestätigung;–;unbefristet;",
      "",
    ]);
  });
});
