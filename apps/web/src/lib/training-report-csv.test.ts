import { describe, expect, it } from "vitest";
import type { TrainingReportCourseResponse } from "@sinnlos/domain";

import { csvCell, receiptsCsv, statusCsv, toCsv } from "./training-report-csv";

/**
 * The training report CSVs (v0.20): Excel-ready (BOM, semicolons, CRLF),
 * quoting, formula neutralising, dates in APP_TIME_ZONE.
 */

const TZ = "Europe/Berlin";

const report: TrainingReportCourseResponse["data"] = {
  scope: "all",
  department: null,
  course: {
    documentId: "c".repeat(24),
    title: "Stapler",
    slug: "stapler",
    validityMonths: 12,
    lessonCount: 2,
    departments: [],
    counts: { done: 1, dueSoon: 0, expired: 0, open: 1, total: 2 },
  },
  lessons: [
    { documentId: "a".repeat(24), title: "Sicherheit; Teil 1" },
    { documentId: "b".repeat(24), title: "Praxis" },
  ],
  people: [
    {
      userId: 1,
      name: "=HYPERLINK(evil)",
      email: "eve@example.com",
      department: "Lager",
      status: "open",
      completed: 1,
      total: 2,
      completedAt: null,
      dueKey: null,
      receipts: [{ lessonDocumentId: "a".repeat(24), completedAt: "2026-10-01T22:30:00Z" }],
    },
    {
      userId: 2,
      name: 'Ana "Die Fahrerin"',
      email: null,
      department: null,
      status: "done",
      completed: 2,
      total: 2,
      completedAt: "2026-03-31T22:15:00Z",
      dueKey: "2027-04-01",
      receipts: [
        { lessonDocumentId: "a".repeat(24), completedAt: "2026-03-31T22:00:00Z" },
        { lessonDocumentId: "b".repeat(24), completedAt: "2026-03-31T22:15:00Z" },
      ],
    },
  ],
};

describe("csvCell", () => {
  it("quotes separators, quotes and line breaks", () => {
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });

  it("neutralises cells a spreadsheet would read as a formula", () => {
    for (const value of ["=1+1", "+49 170", "-2", "@SUM(A1)", "\tx"]) {
      expect(csvCell(value).replace(/^"/, "").startsWith("'"), value).toBe(true);
    }
    expect(csvCell("\rx")).toBe('"\'\rx"');
  });
});

it("toCsv starts with a BOM and ends every row with CRLF", () => {
  expect(
    toCsv([
      ["a", "b"],
      ["c", null],
    ]),
  ).toBe("\uFEFFa;b\r\nc;\r\n");
});

it("statusCsv lists every person with German labels and dates in the app zone", () => {
  expect(statusCsv(report, TZ).split("\r\n")).toEqual([
    "\uFEFFName;E-Mail;Abteilung;Status;Lektionen;Erledigt am;Fällig am",
    "'=HYPERLINK(evil);eve@example.com;Lager;Offen;1 von 2;;",
    // 22:15 UTC on 31 March is 1 April in Berlin.
    '"Ana ""Die Fahrerin""";;;Gültig;2 von 2;01.04.2026;01.04.2027',
    "",
  ]);
});

it("receiptsCsv has one row per receipt, oldest first, with the lesson title and time", () => {
  expect(receiptsCsv(report, TZ).split("\r\n")).toEqual([
    "\uFEFFName;E-Mail;Abteilung;Lektion;Abgeschlossen am",
    '"Ana ""Die Fahrerin""";;;"Sicherheit; Teil 1";01.04.2026 00:00',
    '"Ana ""Die Fahrerin""";;;Praxis;01.04.2026 00:15',
    '\'=HYPERLINK(evil);eve@example.com;Lager;"Sicherheit; Teil 1";02.10.2026 00:30',
    "",
  ]);
});
