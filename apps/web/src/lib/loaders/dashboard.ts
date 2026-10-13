import { zonedDateKey, zonedDayStart } from "@/lib/plain-date";
import { isReadDenied } from "@/lib/roles";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";
import type { QuickLink } from "@/lib/types";
import { pickLatestNews, type LatestNewsView } from "./announcements";
import { countOfList, countOfWalk, type Count } from "./count";

/**
 * The dashboard (WD03). The people count is NOT here: /api/users has no
 * total, so it is a directory walk the page streams in its own Suspense
 * boundary (lib/loaders/people-count.ts, WD10); the open-confirmation and
 * training banners stream on their own as well.
 */

type Role = string | null | undefined;

/**
 * The sections the viewer's role can read (lib/roles.ts isReadDenied,
 * SH02): the others are neither requested nor shown (guest reads no
 * departments, teams, announcements, kudos or training). An unreadable
 * role (null) still reads: the CMS decides.
 */
export interface DashboardSections {
  org: boolean;
  news: boolean;
  acks: boolean;
  kudos: boolean;
  training: boolean;
}

export function dashboardSections(role: Role): DashboardSections {
  return {
    org: !isReadDenied(role, "departments") && !isReadDenied(role, "teams"),
    news: !isReadDenied(role, "announcements"),
    acks: !isReadDenied(role, "announcements") && !isReadDenied(role, "acknowledgements"),
    kudos: !isReadDenied(role, "kudos"),
    training: !isReadDenied(role, "training"),
  };
}

export interface DashboardView {
  sections: DashboardSections;
  /**
   * The stat tiles; null for a section the role cannot read (no tile).
   * Departments and teams are complete page walks (the rows are the
   * count); events and news are capped feeds and count from their own
   * response's total (issue #26).
   */
  counts: {
    departments: Count | null;
    teams: Count | null;
    events: Count;
    news: Count | null;
  };
  quickLinks: QuickLink[];
  /** null without the news section (the role cannot read announcements). */
  latestNews: LatestNewsView | null;
  /** A read failed: the CMS-down banner, and "–" on its tile. */
  failed: boolean;
  /** A walk stopped at its cap (departments, teams, quick links). */
  truncated: boolean;
}

/**
 * Everything the dashboard renders from the CMS. `now` and `timeZone`
 * (APP_TIME_ZONE) make "upcoming" start at today's first instant in that
 * zone: events that began earlier today, or are still running, count.
 */
export async function loadDashboard(
  role: Role,
  now: Date,
  timeZone: string,
): Promise<DashboardView> {
  const sections = dashboardSections(role);
  const startOfToday = zonedDayStart(zonedDateKey(now, timeZone), timeZone).toISOString();

  const [departments, teams, announcements, events, quickLinks] = await Promise.all([
    sections.org ? tryFetch(() => api.departments.list(), "dashboard") : SKIPPED_READ,
    sections.org ? tryFetch(() => api.teams.list(), "dashboard") : SKIPPED_READ,
    // Targeting is applied by the CMS policy — no department argument.
    sections.news ? tryFetch(() => api.announcements.list(), "dashboard") : SKIPPED_READ,
    // Upcoming only: the tile counts the events that still matter.
    tryFetch(() => api.events.upcoming(startOfToday, now.toISOString()), "dashboard"),
    tryFetch(() => api.quickLinks.list(), "dashboard"),
  ]);

  return {
    sections,
    counts: {
      departments: sections.org ? countOfWalk(departments) : null,
      teams: sections.org ? countOfWalk(teams) : null,
      events: countOfList(events),
      news: sections.news ? countOfList(announcements) : null,
    },
    quickLinks: quickLinks.data?.data ?? [],
    latestNews: sections.news
      ? pickLatestNews(announcements.data?.data ?? [], announcements.failed)
      : null,
    failed:
      departments.failed ||
      teams.failed ||
      announcements.failed ||
      events.failed ||
      quickLinks.failed,
    truncated:
      !!departments.data?.truncated || !!teams.data?.truncated || !!quickLinks.data?.truncated,
  };
}
