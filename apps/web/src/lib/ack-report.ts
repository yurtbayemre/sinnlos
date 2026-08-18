/**
 * Fail-closed completeness derivation for the acknowledgement report.
 *
 * The report recomputes each mandatory announcement's target audience from
 * four independent list walks: the mandatory announcements themselves, the
 * acknowledgements, the team roster and the user directory. Every one of
 * those walks stops at a hard safety cap, and if any is cut short the
 * recomputed numbers can only come out too LOW — a shrunken audience reads
 * as HIGHER compliance, a missing ack row reads as an open (non-confirming)
 * user, a dropped announcement vanishes from the report entirely. None of
 * that may be presented as a complete, green "everyone confirmed" (#14).
 *
 * This is a pure function so the fail-closed rule can be unit-tested without
 * the page's Next.js / Strapi runtime.
 */

export interface ReportInputs {
  usersFailed: boolean;
  /** Directory walk stopped at its cap (see users.ts MAX_USERS). */
  usersTruncated: boolean;
  teamsFailed: boolean;
  teamsTruncated: boolean;
  acksFailed: boolean;
  acksTruncated: boolean;
  announcementsFailed: boolean;
  announcementsTruncated: boolean;
}

export interface ReportCompleteness {
  /**
   * The user directory could not be fully determined (fetch failed or the
   * walk was truncated) — EVERY row's audience is unknown, because no user
   * can be reliably placed, so no rate may be shown.
   */
  usersUnknown: boolean;
  /**
   * The team roster could not be fully determined — only rows carrying a
   * `team` criterion are affected; department- and role-scoped rows stay
   * exact.
   */
  teamsUnknown: boolean;
  /**
   * At least one input list was cut short by its safety cap: the report is
   * INCOMPLETE and its totals may be too low. Drives the warning banner and
   * forbids any "complete / all confirmed" reading. Fetch FAILURES are not
   * folded in here — the page surfaces those via its CMS-down banner and the
   * per-row unknown state — so this flag is specifically the silent-cap case.
   */
  truncated: boolean;
}

export function reportCompleteness(inputs: ReportInputs): ReportCompleteness {
  return {
    usersUnknown: inputs.usersFailed || inputs.usersTruncated,
    teamsUnknown: inputs.teamsFailed || inputs.teamsTruncated,
    truncated:
      inputs.usersTruncated ||
      inputs.teamsTruncated ||
      inputs.acksTruncated ||
      inputs.announcementsTruncated,
  };
}
