/**
 * The web's Strapi data client, as one import (WD01 facade). The code
 * lives in:
 *   - lib/strapi/client.ts: strapi() (the transport and the D-DC01
 *     no-store contract, see there), StrapiInit, the list types and
 *     StrapiError (lib/strapi-error.ts, with Strapi's error.name);
 *   - lib/strapi/query.ts: the query-string encoder (structure written as
 *     is, every value percent-encoded);
 *   - lib/api/<domain>.ts: one typed read per Strapi request, with its view
 *     type (what the field-limited populates actually deliver) and the
 *     reasons for its populate, sort and caps.
 * The `api` object keeps the shape every page has used since before the
 * split; lib/strapi-urls.test.ts pins that every request stayed
 * byte-identical through the move. Mutations stay in lib/*-actions.ts
 * (strapi() through this facade) until the action refactor (AC01).
 */
import { departmentBySlug, listDepartments, listTeams, teamBySlug } from "@/lib/api/org";
import { listWikiSpaces, wikiPageBySlug, wikiSpaceBySlug } from "@/lib/api/wiki";
import { listAnnouncements, listRequiringAck } from "@/lib/api/announcements";
import { eventsInWindow, pastEvents, rsvpSummaries, upcomingEvents } from "@/lib/api/events";
import { listPolls, pollResults, pollResultsMany } from "@/lib/api/polls";
import { listDocuments } from "@/lib/api/documents";
import { listCelebrations, listKudos } from "@/lib/api/kudos";
import { classifiedById, listClassifieds, myClassifieds } from "@/lib/api/marketplace";
import { listQuickLinks } from "@/lib/api/quick-links";

export {
  strapi,
  StrapiError,
  type StrapiDataResponse,
  type StrapiInit,
  type StrapiListResponse,
  type StrapiPagination,
} from "@/lib/strapi/client";
export { eventsPastFilter, eventsUpcomingFilter } from "@/lib/api/events";
export { findPollResults, pollRef, type PollRef } from "@/lib/api/polls";

/**
 * Convenience reads for the main collections, grouped as the pages use
 * them. Every read is uncached (D-DC01); the field-limited user populates
 * are data minimisation — a consumer gets only the columns it renders.
 */
export const api = {
  departments: { list: listDepartments, one: departmentBySlug },
  teams: { list: listTeams, one: teamBySlug },
  wiki: { spaces: listWikiSpaces, space: wikiSpaceBySlug, page: wikiPageBySlug },
  announcements: { list: listAnnouncements, requiringAck: listRequiringAck },
  events: {
    upcoming: upcomingEvents,
    past: pastEvents,
    window: eventsInWindow,
    rsvpSummaries,
  },
  polls: { list: listPolls, results: pollResults, resultsMany: pollResultsMany },
  documents: { list: listDocuments },
  kudos: { list: listKudos },
  classifieds: { list: listClassifieds, mine: myClassifieds, one: classifiedById },
  quickLinks: { list: listQuickLinks },
  celebrations: listCelebrations,
};
