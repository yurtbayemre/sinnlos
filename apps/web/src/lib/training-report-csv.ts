import type {
  CourseValidityStatus,
  TrainingCompletionMode,
  TrainingEvidenceRow,
  TrainingReportCourseResponse,
} from "@sinnlos/domain";
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
      // "1/2" would turn into a date in Excel.
      `${person.completed} von ${person.total}`,
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

const MODE_LABELS: Record<TrainingCompletionMode, string> = {
  confirm: "Bestätigung",
  quizGate: "Quiz",
  exam: "Prüfung",
};

const QUIZ_LABELS: Record<TrainingEvidenceRow["quiz"], string> = {
  passed: "bestanden",
  none: "–",
  unknown: "unbekannt",
};

/**
 * One person's training evidence (v0.28, /manage/users/[id], admin only):
 * every receipt, newest first as the cms lists them, from its snapshot, so
 * a deleted course still has its row. Datum; Kurs; Version (the course's
 * publication at completion); Lektion; Abschlussart; Quiz; Gültig bis;
 * Hinweis. A receipt from before v0.28 had its snapshot filled later: its
 * version, quiz and validity are unknown, and the note says so.
 */
export function evidenceCsv(rows: readonly TrainingEvidenceRow[], timeZone: string): string {
  return toCsv([
    ["Datum", "Kurs", "Version", "Lektion", "Abschlussart", "Quiz", "Gültig bis", "Hinweis"],
    ...rows.map((row) => [
      germanInstant(row.completedAt, timeZone, true),
      row.course.title,
      row.version ? germanInstant(row.version, timeZone, true) : "unbekannt",
      row.lesson.title,
      row.completionMode ? MODE_LABELS[row.completionMode] : "unbekannt",
      QUIZ_LABELS[row.quiz],
      row.validity === "until"
        ? germanDay(row.validUntil)
        : row.validity === "noExpiry"
          ? "unbefristet"
          : "unbekannt",
      row.backfilled ? "Stand unbekannt (vor v0.28)" : "",
    ]),
  ]);
}
