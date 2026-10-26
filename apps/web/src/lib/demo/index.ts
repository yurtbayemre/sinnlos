/**
 * The in-memory demo used when DEMO_MODE=1 (DM01): the UI runs without a
 * Strapi instance, against typed per-domain fixtures (`satisfies` or
 * annotated against the web's own types) in the shapes Strapi v5 answers.
 *
 * The contract (docs/architecture.md §5, demo.test.ts):
 *   - strapi() answers every request from demo(path, init) before any
 *     session read or fetch (lib/strapi/client.ts); getSession() answers
 *     DEMO_SESSION, the fixture user Ada Lovelace (id 1, lib/session.ts),
 *     a member;
 *   - the data set is built on first use, dated relative to that day in
 *     APP_TIME_ZONE, and built afresh when the day there changes;
 *   - a route table answers each path template of the api.* reads and the
 *     direct readers: content-type lists apply the request's `filters`,
 *     `sort` and pagination (./query.ts), with a real `meta.pagination`
 *     (page walks end); /api/users answers a BARE ARRAY paged by
 *     start/limit like the users-permissions plugin, /api/users/:id and
 *     /api/users/me the bare user;
 *   - the member writes (./writes.ts) change the data set and answer like
 *     the cms, refusals included: kudos, RSVPs, comments, reactions, votes,
 *     acknowledgements, notifications read, the profile, lesson completion
 *     and quiz feedback, own ads (without images);
 *   - an unknown poll's results answer 404 (a StrapiError, like the cms),
 *     and the batched /api/poll-results leaves it out;
 *   - an unknown read falls through to an empty list, an unknown write to
 *     a 404, each with a console.warn outside production;
 *   - a production server with DEMO_MODE=1 answers every page and route
 *     that reads the session with a 500 (auth.ts throws on its first load).
 */
import type { LessonPlayerResponse } from "@sinnlos/domain";
import { appTimeZone } from "@/lib/app-time-zone";
import { zonedDateKey } from "@/lib/plain-date";
import type { PollResults, UserLite } from "@/lib/types";
import { searchLogSummary } from "./analytics";
import { createDemoData, type DemoData, type DemoHandler } from "./data";
import { DEMO_USER_ID } from "./people";
import { pollByRef, pollResultsOf } from "./polls";
import { quickLinks } from "./quick-links";
import { cmsError, list, query, warn } from "./query";
import * as write from "./writes";

let state: { key: string; data: DemoData } | undefined;

/**
 * The demo data set of today in APP_TIME_ZONE; the writes change it in place.
 * shortcut: it lives in this server process (a restart or a new day resets
 * it, each process has its own), which fits the one-process dev server;
 * a shared store if the demo is ever served by several processes.
 */
function current(): DemoData {
  const zone = appTimeZone();
  const now = new Date();
  const key = `${zone} ${zonedDateKey(now, zone)}`;
  if (state?.key !== key) state = { key, data: createDemoData(zone, now) };
  return state.data;
}

/** GET /api/users: a BARE ARRAY paged by start/limit (users-permissions). */
function userList(directory: UserLite[], params: URLSearchParams): UserLite[] {
  const start = Math.max(0, Number(params.get("start") ?? 0) || 0);
  const limit = Math.max(0, Number(params.get("limit") ?? 100) || 100);
  return query(directory, params).slice(start, start + limit);
}

/** The demo's receipts of one type: all of them are the demo user's. */
const receiptsOf = ({ acknowledgements }: DemoData, targetType: string) =>
  acknowledgements.filter((row) => row.targetType === targetType);

/** GET /api/me/open-acks (v0.31): the mandatory items not confirmed yet. */
function openAcks(data: DemoData) {
  const open = (items: { documentId?: string; requiresAck?: boolean }[], targetType: string) => {
    const acked = new Set(receiptsOf(data, targetType).map((row) => row.targetDocumentId));
    return items.filter(
      (item) => item.requiresAck && item.documentId && !acked.has(item.documentId),
    ).length;
  };
  return {
    data: {
      announcements: open(data.announcements, "announcement"),
      documents: open(data.documents, "document"),
    },
  };
}

/** POST /api/acknowledgements/report-index (v0.31): who confirmed which listed item. */
function reportIndex(data: DemoData, body: unknown) {
  const { targetType, documentIds } = (body ?? {}) as {
    targetType?: unknown;
    documentIds?: unknown;
  };
  if (targetType !== "announcement" && targetType !== "document") {
    throw cmsError(400, "Invalid targetType");
  }
  if (
    !Array.isArray(documentIds) ||
    documentIds.length > 20 ||
    !documentIds.every((id) => typeof id === "string" && id !== "" && id.length <= 64)
  ) {
    throw cmsError(400, "documentIds must be up to 20 documentIds");
  }
  const receipts = receiptsOf(data, targetType);
  const users = (id: unknown) => [
    ...new Set(
      receipts
        .filter((row) => row.targetDocumentId === id && typeof row.user?.id === "number")
        .map((row) => row.user!.id),
    ),
  ];
  return {
    data: { acks: Object.fromEntries(documentIds.map((id: string) => [id, users(id)])) },
    meta: { truncated: false },
  };
}

/** GET /api/event-rsvps/summary?targets=: the FX21 aggregate per listed event. */
function rsvpSummaries({ eventRsvps }: DemoData, params: URLSearchParams) {
  const targets = (params.get("targets") ?? "").split(",").filter(Boolean);
  return {
    data: targets.map((targetDocumentId) => {
      const rows = eventRsvps.filter((row) => row.targetDocumentId === targetDocumentId);
      const count = (status: string) => rows.filter((row) => row.status === status).length;
      return {
        targetDocumentId,
        yesCount: count("yes"),
        maybeCount: count("maybe"),
        noCount: count("no"),
        yesNames: rows
          .filter((row) => row.status === "yes")
          .map((row) => row.user?.displayName ?? ""),
        myStatus: rows.find((row) => row.user?.id === DEMO_USER_ID)?.status ?? null,
      };
    }),
  };
}

/**
 * GET /api/poll-results?ids= (WD04): the results of the known polls, in the
 * order asked, each once; an unknown address is left out, like the cms.
 */
function pollResultsBatch(data: DemoData, params: URLSearchParams) {
  const results: PollResults[] = [];
  for (const ref of (params.get("ids") ?? "").split(",")) {
    const poll = pollByRef(data, ref);
    const one = poll ? pollResultsOf(data, poll) : null;
    if (one && !results.some((entry) => entry.poll.id === one.poll.id)) results.push(one);
  }
  return { data: results };
}

/** The demo's one published version of every course and lesson (v0.28 player `version`). */
const DEMO_PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

/** GET /api/lessons/:id/player: the published lesson without the answer key. */
const lessonPlayer: DemoHandler = ({ data, match }) => {
  const lesson = data.lessonRows.find((row) => row.documentId === decodeURIComponent(match[1]!));
  const course = lesson?.course;
  if (!lesson?.documentId || !course?.documentId || !course.slug) throw cmsError(404, "Not Found");
  return {
    data: {
      documentId: lesson.documentId,
      title: lesson.title,
      body: lesson.body ?? null,
      order: lesson.order ?? 0,
      videoUrl: lesson.videoUrl ?? null,
      course: {
        documentId: course.documentId,
        title: course.title,
        slug: course.slug,
        completionMode: course.completionMode ?? "confirm",
      },
      quiz: (data.quizzes[lesson.documentId] ?? []).map(({ question, options }) => ({
        question,
        options,
      })),
      // v0.28: the demo has one published state per row (its creation time stands in).
      version: { course: DEMO_PUBLISHED_AT, lesson: DEMO_PUBLISHED_AT },
    },
  } satisfies LessonPlayerResponse;
};

/**
 * The route table: method, path pattern, handler. Order matters only where
 * patterns overlap (a custom route before its list).
 */
const ROUTES: [method: string, pattern: RegExp, handler: DemoHandler][] = [
  ["GET", /^\/api\/departments$/, ({ data, params }) => list(data.departments, params)],
  ["GET", /^\/api\/teams$/, ({ data, params }) => list(data.teams, params)],
  ["GET", /^\/api\/wiki-spaces$/, ({ data, params }) => list(data.wikiSpaces, params)],
  ["GET", /^\/api\/wiki-pages$/, ({ data, params }) => list(data.wikiPages, params)],
  ["GET", /^\/api\/announcements$/, ({ data, params }) => list(data.announcements, params)],
  ["GET", /^\/api\/acknowledgements$/, ({ data, params }) => list(data.acknowledgements, params)],
  ["POST", /^\/api\/acknowledgements$/, write.acknowledge],
  ["POST", /^\/api\/acknowledgements\/report-index$/, ({ data, body }) => reportIndex(data, body)],
  ["GET", /^\/api\/events$/, ({ data, params }) => list(data.events, params)],
  ["GET", /^\/api\/event-rsvps\/summary$/, ({ data, params }) => rsvpSummaries(data, params)],
  ["GET", /^\/api\/event-rsvps$/, ({ data, params }) => list(data.eventRsvps, params)],
  ["POST", /^\/api\/event-rsvps$/, write.rsvp],
  [
    "GET",
    /^\/api\/polls\/([^/]+)\/results$/,
    ({ data, match }) => {
      const poll = pollByRef(data, decodeURIComponent(match[1]!));
      const results = poll ? pollResultsOf(data, poll) : null;
      if (!results) throw cmsError(404, "Not Found");
      return results;
    },
  ],
  ["POST", /^\/api\/polls\/([^/]+)\/vote$/, write.vote],
  ["GET", /^\/api\/polls$/, ({ data, params }) => list(data.polls, params)],
  ["GET", /^\/api\/poll-results$/, ({ data, params }) => pollResultsBatch(data, params)],
  ["GET", /^\/api\/kudos-entries$/, ({ data, params }) => list(data.kudosEntries, params)],
  ["POST", /^\/api\/kudos-entries$/, write.sendKudos],
  ["GET", /^\/api\/celebrations$/, ({ data }) => ({ data: data.celebrations })],
  ["GET", /^\/api\/documents$/, ({ data, params }) => list(data.documents, params)],
  ["GET", /^\/api\/duty-plans$/, ({ data, params }) => list(data.dutyPlans, params)],
  ["GET", /^\/api\/kpis$/, ({ data, params }) => list(data.kpis, params)],
  ["GET", /^\/api\/classifieds$/, ({ data, params }) => list(data.classifieds, params)],
  ["POST", /^\/api\/classifieds$/, write.createAd],
  ["PUT", /^\/api\/classifieds\/(\d+)$/, write.updateAd],
  ["DELETE", /^\/api\/classifieds\/(\d+)$/, write.deleteAd],
  ["GET", /^\/api\/courses$/, ({ data, params }) => list(data.courses, params)],
  ["GET", /^\/api\/lessons\/([^/]+)\/player$/, lessonPlayer],
  ["POST", /^\/api\/lessons\/([^/]+)\/check$/, write.checkLesson],
  ["GET", /^\/api\/lessons$/, ({ data, params }) => list(data.lessonRows, params)],
  ["GET", /^\/api\/lesson-progresses$/, ({ data, params }) => list(data.lessonProgress, params)],
  ["POST", /^\/api\/lesson-progresses$/, write.completeLesson],
  ["GET", /^\/api\/quick-links$/, ({ params }) => list(quickLinks, params)],
  ["GET", /^\/api\/notifications$/, ({ data, params }) => list(data.notifications, params)],
  // v0.28: the admin's platform-wide unread total (the demo has one recipient).
  [
    "GET",
    /^\/api\/notifications\/unread-count$/,
    ({ data }) => ({ count: data.notifications.filter((row) => !row.readAt).length }),
  ],
  ["POST", /^\/api\/notifications\/mark-read$/, write.markNotificationsRead],
  ["POST", /^\/api\/notifications\/mark-all-read$/, write.markAllNotificationsRead],
  ["GET", /^\/api\/comments$/, ({ data, params }) => list(data.comments, params)],
  ["POST", /^\/api\/comments$/, write.addComment],
  ["DELETE", /^\/api\/comments\/(\d+)$/, write.deleteComment],
  ["GET", /^\/api\/reactions$/, ({ data, params }) => list(data.reactions, params)],
  ["POST", /^\/api\/reactions$/, write.setReaction],
  ["GET", /^\/api\/search-logs\/summary$/, () => searchLogSummary],
  ["POST", /^\/api\/search-logs$/, write.logSearch],
  ["GET", /^\/api\/users$/, ({ data, params }) => userList(data.directory, params)],
  ["GET", /^\/api\/users\/me$/, ({ data }) => data.directory.find((u) => u.id === DEMO_USER_ID)],
  // An unknown id answers an empty body, like the users-permissions findOne.
  [
    "GET",
    /^\/api\/users\/(\d+)$/,
    ({ data, match }) => data.directory.find((u) => String(u.id) === match[1]),
  ],
  ["GET", /^\/api\/me$/, ({ data }) => ({ data: data.me })],
  ["GET", /^\/api\/me\/open-acks$/, ({ data }) => openAcks(data)],
  ["PUT", /^\/api\/me$/, write.updateMe],
];

/** A write's JSON body; anything else is no body. */
function jsonBody(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * The demo's answer for a Strapi `path` (with its query string) and the
 * request's method and body, as strapi() would receive them. Throws a
 * StrapiError where the cms answers an error.
 */
export function demo(path: string, init: { method?: string; body?: unknown } = {}): unknown {
  const [pathname = "", search = ""] = path.split(/\?(.*)/s);
  const params = new URLSearchParams(search);
  const method = (init.method ?? "GET").toUpperCase();
  for (const [verb, pattern, handler] of ROUTES) {
    const match = verb === method ? pathname.match(pattern) : null;
    // A copy, like a parsed response: a later write must not change what a caller already holds.
    if (match) {
      return structuredClone(
        handler({ data: current(), params, match, body: jsonBody(init.body) }),
      );
    }
  }
  warn(`no fixture for ${method} ${path}`);
  if (method !== "GET") throw cmsError(404, "Not Found");
  return list([], params);
}
