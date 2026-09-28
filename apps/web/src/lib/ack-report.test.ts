import { describe, expect, it } from "vitest";
import {
  buildAckReportRows,
  eligibleReportUsers,
  reportCompleteness,
  type ReportAck,
  type ReportAnnouncement,
  type ReportInputs,
  type ReportUser,
} from "./ack-report";

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

/**
 * The report rows (WD02: moved out of the /manage/acknowledgements page
 * unchanged). Audience rules are lib/audience.ts; these pin the report's
 * own arithmetic and its fail-closed unknown state.
 */
describe("buildAckReportRows", () => {
  const ROLE = { admin: 1, member: 5, guest: 6 };
  /** What the page passes: the roles with announcement.find. */
  const READERS = new Set([
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
    "authenticated",
  ]);
  const user = (id: number, extra: Partial<ReportUser> = {}): ReportUser => ({
    id,
    username: `u${id}`,
    role: { id: ROLE.member, type: "member" },
    department: { id: 10, name: "Engineering" },
    ...extra,
  });
  const announcement = (
    id: number,
    extra: Partial<ReportAnnouncement> = {},
  ): ReportAnnouncement => ({
    id,
    documentId: `ann${String(id).padStart(21, "0")}`,
    title: `A${id}`,
    requiresAck: true,
    ...extra,
  });
  const ack = (a: ReportAnnouncement, userId: number | null): ReportAck => ({
    targetDocumentId: a.documentId!,
    user: userId === null ? null : { id: userId },
  });
  const rows = (
    announcements: ReportAnnouncement[],
    acks: ReportAck[],
    users: ReportUser[],
    flags: { usersUnknown?: boolean; teamsUnknown?: boolean; teams?: Map<number, number[]> } = {},
  ) =>
    buildAckReportRows({
      announcements,
      acks,
      eligibleUsers: eligibleReportUsers(users, READERS),
      userTeamIds: flags.teams ?? new Map(),
      usersUnknown: flags.usersUnknown ?? false,
      teamsUnknown: flags.teamsUnknown ?? false,
    });

  it("counts confirmations of the targeted users and lists the open ones", () => {
    const a = announcement(1);
    const [row] = rows([a], [ack(a, 1), ack(a, 2)], [user(1), user(2), user(3)]);
    expect(row).toMatchObject({ ackedCount: 2, pct: 67, targetUnknown: false });
    expect(row!.targetUsers.map((u) => u.id)).toEqual([1, 2, 3]);
    expect(row!.openUsers.map((u) => u.id)).toEqual([3]);
  });

  it.each([
    [1, 3, 33],
    [2, 3, 67],
    [1, 8, 13], // 12.5 rounds half up
    [7, 8, 88], // 87.5 rounds half up
    [0, 4, 0],
    [4, 4, 100],
  ])("rounds %i of %i to %i%%", (acked, total, pct) => {
    const a = announcement(1);
    const users = Array.from({ length: total }, (_, i) => user(i + 1));
    const acks = users.slice(0, acked).map((u) => ack(a, u.id));
    expect(rows([a], acks, users)[0]).toMatchObject({ ackedCount: acked, pct });
  });

  it("reads 0% for an empty audience (never a division by zero)", () => {
    const a = announcement(1, { department: { id: 99, name: "Nobody" } });
    expect(rows([a], [], [user(1)])[0]).toMatchObject({ targetUsers: [], ackedCount: 0, pct: 0 });
  });

  it("counts a user's duplicate acks once and ignores acks of other announcements and users", () => {
    const a = announcement(1);
    const other = announcement(2);
    const [row] = rows(
      [a],
      [ack(a, 1), ack(a, 1), ack(other, 2), ack(a, 42), ack(a, null)],
      [user(1), user(2)],
    );
    expect(row).toMatchObject({ ackedCount: 1, pct: 50 });
    expect(row!.openUsers.map((u) => u.id)).toEqual([2]);
  });

  it("leaves blocked users, guests and role-less users out of every audience", () => {
    const a = announcement(1);
    const [row] = rows(
      [a],
      [],
      [
        user(1),
        user(2, { blocked: true }),
        user(3, { role: { id: ROLE.guest, type: "guest" } }),
        user(4, { role: null }),
        user(5, { role: { id: ROLE.admin, type: "admin_role" } }),
      ],
    );
    expect(row!.targetUsers.map((u) => u.id)).toEqual([1, 5]);
  });

  it("applies department, team and role targeting", () => {
    const users = [
      user(1),
      user(2, { department: { id: 11, name: "Ops" } }),
      user(3, { role: { id: ROLE.admin, type: "admin_role" } }),
    ];
    const teams = new Map([[1, [30]]]);
    const byDepartment = announcement(1, { department: { id: 11, name: "Ops" } });
    const byTeam = announcement(2, { team: { id: 30, name: "Frontend" } });
    const byRole = announcement(3, { audienceRoles: [{ id: ROLE.admin, type: "admin_role" }] });
    const result = rows([byDepartment, byTeam, byRole], [], users, { teams });
    expect(result.map((r) => r.targetUsers.map((u) => u.id))).toEqual([[2], [1], [3]]);
  });

  it("marks EVERY row unknown without a complete user directory", () => {
    const result = rows([announcement(1), announcement(2, { team: { id: 30 } })], [], [user(1)], {
      usersUnknown: true,
    });
    expect(result.map((r) => r.targetUnknown)).toEqual([true, true]);
  });

  it("marks only team-scoped rows unknown without a complete team roster", () => {
    const result = rows(
      [
        announcement(1),
        announcement(2, { team: { id: 30 } }),
        announcement(3, { department: { id: 10 } }),
      ],
      [],
      [user(1)],
      { teamsUnknown: true },
    );
    expect(result.map((r) => r.targetUnknown)).toEqual([false, true, false]);
  });

  it("keeps the announcement order and yields no rows without announcements", () => {
    const list = [announcement(3), announcement(1), announcement(2)];
    expect(rows(list, [], [user(1)]).map((r) => r.announcement.id)).toEqual([3, 1, 2]);
    expect(rows([], [], [user(1)])).toEqual([]);
  });
});
