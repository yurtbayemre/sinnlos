import type { CourseValidityStatus, TrainingReportCourseResponse } from "@sinnlos/domain";
import { instantEpochMs, isPlainDate, zonedDateKey, zonedTimeOfDay } from "@/lib/plain-date";

/**
 * The CSV downloads of the named training report (v0.20): the status of
 * every person, and the proof history (one row per receipt). Built for
 * Excel: UTF-8 with BOM, semicolons, CRLF. A cell that a spreadsheet would
 * read as a formula (= + - @, tab, CR) gets a leading apostrophe, since
 * names and titles are user-entered.
 * shortcut: German headers and labels only (the proof goes to German
 * authorities); take them from the messages if a second locale needs CSVs.
 */

type Report = TrainingReportCourseResponse["data"];

export const STATUS_LABELS: Record<CourseValidityStatus, string> = {
  done: "Gültig",
  dueSoon: "Läuft bald ab",
  expired: "Abgelaufen",
  open: "Offen",
};

/** One cell: formula-neutralised, quoted when it holds ; " CR or LF. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows to a CSV document: BOM, one line per row, CRLF after every line. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";") + "\r\n").join("")}`;
}

/** 'YYYY-MM-DD' → 'dd.mm.yyyy'; "" for anything else. */
function germanDay(key: string | null): string {
  if (!key || !isPlainDate(key)) return "";
  const [year, month, day] = key.split("-");
  return `${day}.${month}.${year}`;
}

/** An instant as 'dd.mm.yyyy' (or with ' HH:mm') in the app zone; "" when unreadable. */
function germanInstant(iso: string | null, timeZone: string, withTime: boolean): string {
  if (!iso || instantEpochMs(iso) === null) return "";
  const day = germanDay(zonedDateKey(iso, timeZone));
  return withTime ? `${day} ${zonedTimeOfDay(iso, timeZone)}` : day;
}

/** Name; E-Mail; Abteilung; Status; Lektionen; Erledigt am; Fällig am. */
export function statusCsv(report: Report, timeZone: string): string {
  return toCsv([
    ["Name", "E-Mail", "Abteilung", "Status", "Lektionen", "Erledigt am", "Fällig am"],
    ...report.people.map((person) => [
      person.name,
      person.email,
      person.department,
      STATUS_LABELS[person.status],
      `${person.completed}/${person.total}`,
      germanInstant(person.completedAt, timeZone, false),
      germanDay(person.dueKey),
    ]),
  ]);
}

/** Name; E-Mail; Abteilung; Lektion; Abgeschlossen am — one row per receipt, oldest first. */
export function receiptsCsv(report: Report, timeZone: string): string {
  const titles = new Map(report.lessons.map((lesson) => [lesson.documentId, lesson.title]));
  const rows = report.people.flatMap((person) =>
    person.receipts.map((receipt) => ({ person, receipt })),
  );
  rows.sort(
    (a, b) =>
      (instantEpochMs(a.receipt.completedAt ?? "") ?? 0) -
      (instantEpochMs(b.receipt.completedAt ?? "") ?? 0),
  );
  return toCsv([
    ["Name", "E-Mail", "Abteilung", "Lektion", "Abgeschlossen am"],
    ...rows.map(({ person, receipt }) => [
      person.name,
      person.email,
      person.department,
      titles.get(receipt.lessonDocumentId) ?? receipt.lessonDocumentId,
      germanInstant(receipt.completedAt, timeZone, true),
    ]),
  ]);
}
