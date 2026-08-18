import { describe, expect, it } from "vitest";
import { reportCompleteness, type ReportInputs } from "./ack-report";

/**
 * The acknowledgement report recomputes compliance from four capped list
 * walks. If any is cut short the totals can only come out too low, so the
 * report must fail closed: warn, and never read as a complete "everyone
 * confirmed". These pin that rule (issue #14).
 */
const clean: ReportInputs = {
  usersFailed: false,
  usersTruncated: false,
  teamsFailed: false,
  teamsTruncated: false,
  acksFailed: false,
  acksTruncated: false,
  announcementsFailed: false,
  announcementsTruncated: false,
};

describe("reportCompleteness", () => {
  it("reports complete when every walk finished", () => {
    expect(reportCompleteness(clean)).toEqual({
      usersUnknown: false,
      teamsUnknown: false,
      truncated: false,
    });
  });

  it.each(["usersTruncated", "teamsTruncated", "acksTruncated", "announcementsTruncated"] as const)(
    "marks the report incomplete when %s",
    (flag) => {
      expect(reportCompleteness({ ...clean, [flag]: true }).truncated).toBe(true);
    },
  );

  it("does not treat a fetch failure as a silent-cap truncation", () => {
    // Failures are surfaced by the CMS-down banner and the per-row unknown
    // state, not by the truncation banner.
    const r = reportCompleteness({
      ...clean,
      usersFailed: true,
      teamsFailed: true,
      acksFailed: true,
      announcementsFailed: true,
    });
    expect(r.truncated).toBe(false);
  });

  it("degrades the users audience to unknown on failure OR truncation", () => {
    expect(reportCompleteness({ ...clean, usersFailed: true }).usersUnknown).toBe(true);
    expect(reportCompleteness({ ...clean, usersTruncated: true }).usersUnknown).toBe(true);
  });

  it("degrades the team audience to unknown on failure OR truncation", () => {
    expect(reportCompleteness({ ...clean, teamsFailed: true }).teamsUnknown).toBe(true);
    expect(reportCompleteness({ ...clean, teamsTruncated: true }).teamsUnknown).toBe(true);
  });
});
