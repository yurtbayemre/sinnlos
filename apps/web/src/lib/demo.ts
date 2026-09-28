/**
 * In-memory demo dataset used when DEMO_MODE=1, so the UI can be
 * previewed without a running Strapi instance (DM01-lite: DEMO_MODE is a
 * frozen, best-effort PREVIEW, never a second backend). The shapes match
 * what Strapi v5 flat responses return, and the fixtures are checked
 * against the web's own types (`satisfies`).
 *
 * The contract (docs/architecture.md §5, demo.test.ts):
 *   - strapi() answers every request from demo(path) before any session
 *     read or fetch (lib/strapi/client.ts); getSession() answers
 *     DEMO_SESSION, the fixture user Ada Lovelace (id 1, lib/session.ts);
 *   - a small route table answers each path template of the api.* reads
 *     and the direct readers: content-type lists apply the request's
 *     `filters` ($eq/$ne/$lt/$lte/$gt/$gte/$null/$notNull/$in/$containsi,
 *     nested $or/$and, relation paths), `sort` and pagination, with a real
 *     `meta.pagination` (page walks end); /api/users answers a BARE ARRAY
 *     paged by start/limit like the users-permissions plugin,
 *     /api/users/:id and /api/users/me the bare user;
 *   - an unknown poll's results answer 404 (a StrapiError, like the cms);
 *   - anything else (a mutation, an unknown path) falls through to an
 *     empty list, with a console.warn outside production;
 *   - a production server refuses DEMO_MODE=1 at start (auth.ts).
 */
import { appTimeZone } from "@/lib/app-time-zone";
import {
  DEFAULT_APP_TIME_ZONE,
  addDaysToKey,
  zonedDateKey,
  zonedWallTimeToInstant,
} from "@/lib/plain-date";
import { StrapiError } from "@/lib/strapi-error";
import type {
  Acknowledgement,
  Announcement,
  Celebration,
  Classified,
  Comment,
  Course,
  Department,
  Document,
  Event,
  EventRsvp,
  Kudos,
  Lesson,
  LessonProgress,
  Notification,
  Poll,
  PollResults,
  QuickLink,
  Reaction,
  Team,
  UserLite,
  WikiPage,
  WikiSpace,
} from "@/lib/types";

const users = {
  ada: {
    id: 1,
    username: "ada",
    email: "ada@sinnlos.local",
    displayName: "Ada Lovelace",
    jobTitle: "Head of Engineering",
  },
  grace: {
    id: 2,
    username: "grace",
    email: "grace@sinnlos.local",
    displayName: "Grace Hopper",
    jobTitle: "Platform Lead",
  },
  linus: {
    id: 3,
    username: "linus",
    email: "linus@sinnlos.local",
    displayName: "Linus T.",
    jobTitle: "Senior Engineer",
  },
  maria: {
    id: 4,
    username: "maria",
    email: "maria@sinnlos.local",
    displayName: "Maria Weber",
    jobTitle: "Head of People",
  },
  jonas: {
    id: 5,
    username: "jonas",
    email: "jonas@sinnlos.local",
    displayName: "Jonas Keller",
    jobTitle: "Recruiter",
  },
  sofia: {
    id: 6,
    username: "sofia",
    email: "sofia@sinnlos.local",
    displayName: "Sofia Martín",
    jobTitle: "Head of Marketing",
  },
} satisfies Record<string, UserLite>;

/** The demo user (DEMO_SESSION, DEMO_VIEWER): Ada Lovelace. */
const DEMO_USER_ID = users.ada.id;

/**
 * Fixture dates relative to today in APP_TIME_ZONE (datetime contract,
 * phase 2): iso(3, 17) is 17:00 there three days from now, whatever zone
 * the process runs in (the local setHours before gave 17:00 of the process
 * zone, 19:00 Berlin time in a UTC container), and dateOnly(n) is a
 * calendar date. Resolved once at import, like the fixtures; this module is
 * imported by the Strapi client in every mode, so an invalid APP_TIME_ZONE
 * falls back to the default here (instrumentation.ts refuses to serve with
 * it).
 */
const DEMO_ZONE = (() => {
  try {
    return appTimeZone();
  } catch {
    return DEFAULT_APP_TIME_ZONE;
  }
})();
const DEMO_TODAY = zonedDateKey(new Date(), DEMO_ZONE);
const iso = (offsetDays: number, hour = 10) =>
  zonedWallTimeToInstant(
    addDaysToKey(DEMO_TODAY, offsetDays),
    `${String(hour).padStart(2, "0")}:00`,
    DEMO_ZONE,
  ).toISOString();
const dateOnly = (offsetDays: number) => addDaysToKey(DEMO_TODAY, offsetDays);

const departments = [
  {
    id: 1,
    documentId: "demo-department-1",
    name: "Engineering",
    slug: "engineering",
    description: "We build and operate the product platform.",
    color: "#6366f1",
    head: users.ada,
    members: [users.ada, users.grace, users.linus],
    teams: [
      { id: 10, name: "Platform", slug: "platform", description: "Core infra and APIs" },
      { id: 11, name: "Web", slug: "web", description: "Next.js frontend & design system" },
      { id: 12, name: "Data", slug: "data", description: "Analytics, ML, warehouse" },
    ],
  },
  {
    id: 2,
    documentId: "demo-department-2",
    name: "People & Culture",
    slug: "people-culture",
    description: "Hiring, onboarding, office and wellbeing.",
    color: "#14b8a6",
    head: users.maria,
    members: [users.maria, users.jonas],
    teams: [
      { id: 20, name: "Recruiting", slug: "recruiting", description: "Talent pipeline" },
      { id: 21, name: "Workplace", slug: "workplace", description: "Office & IT" },
    ],
  },
  {
    id: 3,
    documentId: "demo-department-3",
    name: "Marketing",
    slug: "marketing",
    description: "Brand, growth and content.",
    color: "#f97316",
    head: users.sofia,
    members: [users.sofia],
    teams: [
      { id: 30, name: "Brand", slug: "brand", description: "Identity & campaigns" },
      { id: 31, name: "Growth", slug: "growth", description: "Paid and lifecycle" },
    ],
  },
] satisfies Department[];

/** A department as a relation of another row (no nested relations). */
const departmentRef = (d: Department) => ({ id: d.id, name: d.name, slug: d.slug });

const teams: Team[] = departments.flatMap((d) =>
  d.teams.map((t) => ({
    ...t,
    department: departmentRef(d),
    lead: d.head,
    members: d.members,
  })),
);

const wikiSpaces = [
  {
    id: 1,
    name: "Handbook",
    slug: "handbook",
    description: "How we work, our values and policies.",
    visibility: "public",
    pages: [
      {
        id: 101,
        title: "Welcome to Sinnlos",
        slug: "welcome",
        summary: "Start here — a 5 minute tour of the intranet.",
        body: `# Welcome to Sinnlos\n\nThis intranet is **self-hosted**, gated by Microsoft Entra ID SSO, and organised around three pillars:\n\n- **Wiki** — handbooks, how-tos and knowledge bases\n- **Departments** — org units with members, teams and pinned pages\n- **Teams** — small groups inside departments\n\n## Why it exists\n\nWe wanted a single place that's fast, searchable, and role-aware.\n\n- [x] Microsoft SSO\n- [x] Markdown wiki with revisions\n- [x] Department & team pages\n- [ ] Calendar integration (coming soon)\n\n\`\`\`ts\nconsole.log("Hello, intranet!");\n\`\`\``,
        author: users.ada,
        lastEditor: users.ada,
        updatedAt: new Date().toISOString(),
      },
      {
        id: 102,
        title: "Remote work policy",
        slug: "remote-work",
        summary: "Our stance on flexibility, core hours and equipment.",
        body: `# Remote work policy\n\nWe trust people to do great work from wherever they are most productive.\n\n## Core principles\n\n1. **Async by default** — assume written context first\n2. **Overlap** — keep 3 hours of timezone overlap with your team\n3. **Equipment** — laptops and monitors are company-provided\n\n> "The best work happens when people are trusted."`,
        author: users.maria,
        lastEditor: users.maria,
        updatedAt: new Date().toISOString(),
      },
    ],
  },
  {
    id: 2,
    name: "Engineering",
    slug: "engineering",
    description: "Runbooks, ADRs and platform docs.",
    visibility: "department",
    pages: [
      {
        id: 201,
        title: "Incident response",
        slug: "incident-response",
        summary: "PagerDuty rotations and severity levels.",
        body: `# Incident response\n\nSev levels: **Sev1** (full outage), **Sev2** (degraded), **Sev3** (minor).\n\n- Acknowledge in PagerDuty within 5 minutes\n- Open #incident-YYYYMMDD channel\n- Post a public postmortem within 72h`,
        author: users.grace,
        lastEditor: users.linus,
        updatedAt: new Date().toISOString(),
      },
    ],
  },
] satisfies WikiSpace[];

/** Every wiki page with its space (the /api/wiki-pages rows). */
const wikiPages: WikiPage[] = wikiSpaces.flatMap((s) =>
  s.pages.map((p) => ({ ...p, space: { id: s.id, name: s.name, slug: s.slug } })),
);

const announcements = [
  {
    id: 1,
    documentId: "demo-ann-1",
    title: "Q2 All-hands this Friday",
    requiresAck: true,
    // A calendar date, like the cms's `date` field.
    ackDeadline: dateOnly(7),
    body: "Join us at 15:00 CET in the main auditorium or on Teams. Agenda: quarterly numbers, product roadmap, and a live demo of the new intranet.",
    pinned: true,
    createdAt: new Date().toISOString(),
    author: users.maria,
  },
  {
    id: 2,
    documentId: "demo-ann-2",
    title: "New wiki search is live",
    body: "Hit ⌘K anywhere in the app to fuzzy search wiki pages, people and teams. Special filters: `in:handbook`, `by:@grace`, `tag:runbook`.",
    pinned: true,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    author: users.ada,
  },
  {
    id: 3,
    documentId: "demo-ann-3",
    title: "Office closed Mon 2026-05-01",
    body: "Public holiday. Remote work as usual. On-call rotation is unchanged — please check your PagerDuty schedule.",
    pinned: false,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    author: users.jonas,
  },
  {
    id: 4,
    documentId: "demo-ann-4",
    title: "Welcome Sofia to Marketing",
    body: "Sofia Martín joins us this week as Head of Marketing, coming from a background in brand and growth at two previous startups.",
    pinned: false,
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    author: users.maria,
  },
  {
    id: 5,
    documentId: "demo-ann-5",
    title: "Infra maintenance window: Sat 02:00–04:00 CET",
    body: "Platform team will be upgrading Postgres and rotating TLS certificates. Expect brief blips on API calls during the window.",
    pinned: false,
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    author: users.grace,
  },
  {
    id: 6,
    documentId: "demo-ann-6",
    title: "Engineering handbook v2 published",
    body: "New sections on incident response, ADR workflow, and our updated code review checklist. Read it in the Wiki → Engineering space.",
    pinned: false,
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    author: users.linus,
  },
] satisfies Announcement[];

/**
 * Fixtures for the modules added after the original demo set (issue #15):
 * kudos, polls, events + RSVPs, documents, notifications, quick links,
 * marketplace, celebrations. Shapes mirror the real API responses the
 * pages consume — dates are computed relative to "now" (iso/dateOnly
 * above) so the events month view and expiry filters always show content.
 */

const events = [
  {
    id: 1,
    documentId: "demo-event-1",
    title: "Summer team barbecue",
    description: "Rooftop terrace, vegetarian options included. Bring your +1!",
    start: iso(3, 17),
    end: iso(3, 21),
    rsvpEnabled: true,
    capacity: 40,
    location: "Rooftop, HQ",
    organizer: users.maria,
    departments: [],
    createdAt: iso(-10),
  },
  {
    id: 2,
    documentId: "demo-event-2",
    title: "Engineering demo day",
    description: "Platform, Web and Data show what shipped this quarter.",
    start: iso(8, 14),
    end: iso(8, 16),
    rsvpEnabled: false,
    location: "Auditorium + Teams",
    organizer: users.ada,
    departments: [{ id: 1, name: "Engineering", slug: "engineering" }],
    createdAt: iso(-6),
  },
  {
    id: 3,
    documentId: "demo-event-3",
    title: "Onboarding week welcome breakfast",
    description: "Meet the new joiners over coffee and croissants.",
    start: iso(-4, 9),
    end: iso(-4, 10),
    allDay: false,
    location: "Kitchen, 2nd floor",
    organizer: users.jonas,
    departments: [{ id: 2, name: "People & Culture", slug: "people-culture" }],
    createdAt: iso(-15),
  },
] satisfies Event[];

const eventRsvps = [
  { id: 1, targetDocumentId: "demo-event-1", status: "yes", respondedAt: iso(-2), user: users.ada },
  {
    id: 2,
    targetDocumentId: "demo-event-1",
    status: "yes",
    respondedAt: iso(-1),
    user: users.grace,
  },
  {
    id: 3,
    targetDocumentId: "demo-event-1",
    status: "maybe",
    respondedAt: iso(-1),
    user: users.linus,
  },
  {
    id: 4,
    targetDocumentId: "demo-event-1",
    status: "no",
    respondedAt: iso(-3),
    user: users.sofia,
  },
] satisfies EventRsvp[];

const polls = [
  {
    id: 1,
    documentId: "demo-poll-1",
    question: "Where should the winter offsite happen?",
    options: ["Mountains (ski + sauna)", "City trip (Lisbon)", "Countryside retreat"],
    closesAt: iso(5),
    anonymous: false,
    author: users.maria,
    audience: "all",
    departments: [],
    // Guest access (owner decision 2026-09-27): opened to guests, with voting.
    visibleToGuests: true,
    guestsCanVote: true,
    createdAt: iso(-2),
  },
  {
    id: 2,
    documentId: "demo-poll-2",
    question: "How useful was the new incident-response training?",
    options: ["Very useful", "Somewhat useful", "Not useful"],
    closesAt: iso(-1),
    anonymous: true,
    author: users.grace,
    audience: "departments",
    departments: [
      { id: 1, documentId: "demo-department-1", name: "Engineering", slug: "engineering" },
    ],
    // Hidden from guests (the default).
    visibleToGuests: false,
    guestsCanVote: false,
    createdAt: iso(-9),
  },
] satisfies Poll[];

/** The counts, the demo user's vote and the audience per poll. */
const pollTallies: Record<string, Omit<PollResults, "poll">> = {
  "demo-poll-1": {
    counts: [9, 6, 4],
    total: 19,
    myVoteIndex: null,
    canVote: true,
    audience: { targeted: false, departments: [] },
  },
  "demo-poll-2": {
    counts: [14, 5, 1],
    total: 20,
    myVoteIndex: 0,
    // Targeted at the demo viewer's own department (DEMO_VIEWER, Engineering).
    canVote: true,
    audience: {
      targeted: true,
      departments: [{ documentId: "demo-department-1", name: "Engineering" }],
    },
  },
};

/** The results body of a poll, as GET /api/polls/:id/results answers it. */
function pollResultsOf(poll: Poll): PollResults | null {
  const tally = poll.documentId ? pollTallies[poll.documentId] : undefined;
  if (!tally) return null;
  return {
    poll: {
      id: poll.id,
      question: poll.question,
      options: poll.options,
      closesAt: poll.closesAt,
      anonymous: poll.anonymous ?? false,
      visibleToGuests: poll.visibleToGuests === true,
      guestsCanVote: poll.guestsCanVote === true,
    },
    ...tally,
  };
}

const kudosEntries = [
  {
    id: 1,
    message: "For calmly steering the Sev2 last Tuesday to a fix before lunch.",
    value: "leadership",
    from: users.ada,
    to: users.grace,
    createdAt: iso(-1),
  },
  {
    id: 2,
    message: "The new onboarding checklist is a thing of beauty — new joiners notice.",
    value: "excellence",
    from: users.grace,
    to: users.jonas,
    createdAt: iso(-2),
  },
  {
    id: 3,
    message: "Jumped on the landing-page bug on a Friday evening. Above and beyond.",
    value: "teamwork",
    from: users.sofia,
    to: users.linus,
    createdAt: iso(-4),
  },
  {
    id: 4,
    message: "Turned a vague idea into a working prototype in two days.",
    value: "innovation",
    from: users.maria,
    to: users.ada,
    createdAt: iso(-6),
  },
] satisfies Kudos[];

const celebrations = [
  { user: users.jonas, type: "birthday", date: dateOnly(2), daysUntil: 2 },
  { user: users.grace, type: "work-anniversary", years: 3, daysUntil: 9 },
] satisfies Celebration[];

const documents = [
  {
    id: 1,
    documentId: "demo-doc-1",
    title: "Travel & expense policy",
    description: "Per-diems, booking rules and how to file expenses.",
    category: "policy",
    file: {
      url: "/uploads/demo-travel-policy.pdf",
      name: "travel-policy.pdf",
      size: 412,
      mime: "application/pdf",
    },
    departments: [],
    uploadedBy: users.maria,
    createdAt: iso(-30),
    updatedAt: iso(-3),
  },
  {
    id: 2,
    documentId: "demo-doc-2",
    title: "Equipment request form",
    description: "Laptops, monitors, chairs — one form for everything.",
    category: "form",
    file: {
      url: "/uploads/demo-equipment-form.pdf",
      name: "equipment-form.pdf",
      size: 96,
      mime: "application/pdf",
    },
    departments: [{ id: 2, name: "People & Culture", slug: "people-culture" }],
    uploadedBy: users.jonas,
    createdAt: iso(-20),
    updatedAt: iso(-20),
  },
  {
    id: 3,
    documentId: "demo-doc-3",
    title: "Brand guidelines v3",
    description: "Logo usage, color palette and tone of voice.",
    category: "guide",
    file: {
      url: "/uploads/demo-brand-guidelines.pdf",
      name: "brand-guidelines.pdf",
      size: 2380,
      mime: "application/pdf",
    },
    departments: [{ id: 3, name: "Marketing", slug: "marketing" }],
    uploadedBy: users.sofia,
    createdAt: iso(-12),
    updatedAt: iso(-5),
  },
] satisfies Document[];

const classifieds = [
  {
    id: 1,
    documentId: "demo-ad-1",
    title: "City bike, 3 years old, well maintained",
    description: "Freshly serviced, new brake pads. Pickup near the office.",
    category: "sale",
    price: 180,
    priceNegotiable: true,
    location: "HQ / city center",
    images: null,
    expiresAt: dateOnly(21),
    author: users.linus,
    createdAt: iso(-3),
  },
  {
    id: 2,
    documentId: "demo-ad-2",
    title: "Moving boxes to give away",
    description: "About 15 sturdy boxes from a recent move. First come, first served.",
    category: "giveaway",
    price: null,
    location: "2nd floor storage",
    images: null,
    expiresAt: dateOnly(10),
    author: users.jonas,
    createdAt: iso(-1),
  },
  {
    id: 3,
    documentId: "demo-ad-3",
    title: "Looking for a German tandem partner",
    description: "Native Spanish speaker, B1 German — happy to trade lunch breaks.",
    category: "service-wanted",
    price: null,
    location: "Remote / office",
    images: null,
    expiresAt: dateOnly(30),
    author: users.sofia,
    createdAt: iso(-5),
  },
] satisfies Classified[];

const quickLinks = [
  { id: 1, label: "HR portal", url: "https://example.com/hr", icon: "Contact", order: 1 },
  { id: 2, label: "Expense tool", url: "https://example.com/expenses", icon: "Wallet", order: 2 },
  { id: 3, label: "IT helpdesk", url: "https://example.com/helpdesk", icon: "LifeBuoy", order: 3 },
  { id: 4, label: "Meeting rooms", url: "https://example.com/rooms", icon: "Calendar", order: 4 },
  { id: 5, label: "Status page", url: "https://status.example.com", icon: "Globe", order: 5 },
] satisfies QuickLink[];

/** The demo user's notifications (the bell reads them by recipient). */
const notifications = [
  {
    id: 1,
    type: "comment",
    title: 'Grace Hopper commented on "Q2 All-hands this Friday"',
    link: "/announcements",
    readAt: null,
    createdAt: iso(0, 8),
    actor: users.grace,
    recipient: users.ada,
  },
  {
    id: 2,
    type: "kudos",
    title: "Sofia Martín sent you kudos",
    link: "/kudos",
    readAt: null,
    createdAt: iso(-1),
    actor: users.sofia,
    recipient: users.ada,
  },
  {
    id: 3,
    type: "announcement",
    title: "New announcement: Engineering handbook v2 published",
    link: "/announcements",
    readAt: iso(-2),
    createdAt: iso(-2),
    actor: users.linus,
    recipient: users.ada,
  },
] satisfies Notification[];

const demoComments = [
  {
    id: 1,
    body: "Will the session be recorded for the folks on parental leave?",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.grace,
    createdAt: iso(-1, 9),
  },
  {
    id: 2,
    body: "Yes — recording lands in the wiki right after. 🎥",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.maria,
    createdAt: iso(-1, 11),
  },
  {
    id: 3,
    body: "The new search filters are a game changer, thanks team!",
    targetType: "announcement",
    targetDocumentId: "demo-ann-2",
    author: users.jonas,
    createdAt: iso(0, 7),
  },
] satisfies Comment[];

const demoReactions = [
  {
    id: 1,
    emoji: "celebrate",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.grace,
  },
  {
    id: 2,
    emoji: "thumbsup",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.linus,
  },
  {
    id: 3,
    emoji: "heart",
    targetType: "announcement",
    targetDocumentId: "demo-ann-4",
    author: users.ada,
  },
] satisfies Reaction[];

const demoLessons = [
  {
    id: 1,
    documentId: "demo-lesson-1",
    title: "Why security awareness matters",
    order: 1,
    body: '# Why this matters\n\nPhishing is the #1 entry vector. This 5-minute lesson shows the three patterns to watch for:\n\n1. **Urgency** ("act now!")\n2. **Authority** ("the CEO needs...")\n3. **Unusual channels**\n\n> When in doubt: verify via a second channel.',
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    quiz: [
      {
        question: "A mail urges you to pay an invoice within 30 minutes. What do you do?",
        options: [
          "Pay it — sounds urgent",
          "Verify via a known contact on a second channel",
          "Forward it to a colleague",
        ],
        correctIndex: 1,
      },
    ],
  },
  {
    id: 2,
    documentId: "demo-lesson-2",
    title: "Passwords & 2FA",
    order: 2,
    body: "## Rules of thumb\n\n- Use the password manager for **everything**\n- One account, one password\n- 2FA on for mail, VPN and admin tools",
    quiz: [],
  },
  {
    id: 3,
    documentId: "demo-lesson-3",
    title: "Reporting an incident",
    order: 3,
    body: "If something feels off: **report early**. There is no penalty for false alarms — there is for silence.",
    quiz: [],
  },
] satisfies Lesson[];

const demoCourses = [
  {
    id: 1,
    documentId: "demo-course-1",
    title: "Security awareness basics",
    slug: "security-awareness-basics",
    completionMode: "quizGate",
    description: "Mandatory annual security training: phishing, passwords, incident reporting.",
    mandatory: true,
    lessons: demoLessons,
    updatedAt: iso(-4),
  },
  {
    id: 2,
    documentId: "demo-course-2",
    title: "Working with the intranet",
    slug: "working-with-the-intranet",
    description: "Optional tour: wiki, announcements, events and the marketplace.",
    mandatory: false,
    lessons: [
      {
        id: 10,
        documentId: "demo-lesson-10",
        title: "Finding things (search & wiki)",
        order: 1,
        body: "Press **Ctrl+K** anywhere.",
      },
    ],
    updatedAt: iso(-10),
  },
] satisfies Course[];

/** Every lesson with its course (the /api/lessons rows). */
const lessonRows: Lesson[] = demoCourses.flatMap((c) =>
  c.lessons.map((l) => ({
    ...l,
    course: { id: c.id, documentId: c.documentId, title: c.title, slug: c.slug },
  })),
);

const demoLessonProgress = [
  { id: 1, targetDocumentId: "demo-lesson-1", completedAt: iso(-2) },
] satisfies LessonProgress[];

const demoAcknowledgements: Acknowledgement[] = [];

/** The directory as /api/users answers it: every user with a department. */
const directory: UserLite[] = Object.values(users).map((u) => ({
  ...u,
  department: departmentRef(departments[0]),
}));

/** GET /api/me: the demo user's allowlisted self-profile (FX02 shape). */
const me = {
  ...users.ada,
  department: {
    id: 1,
    documentId: "demo-department-1",
    name: "Engineering",
    slug: "engineering",
  },
  role: { type: "member", name: "Member" },
  birthdayVisible: false,
};

// ---------------------------------------------------------------------------
// Strapi's REST query semantics, as far as the web uses them
// ---------------------------------------------------------------------------

/** A parsed `filters` tree: operators and attributes, leaves are the raw values. */
type FilterTree = { [key: string]: FilterTree | string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A property of a row (or of a populated relation). */
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** `filters[a][$or][0][b][$eq]=v` → { a: { $or: { 0: { b: { $eq: "v" } } } } }. */
function filterTree(params: URLSearchParams): FilterTree {
  const tree: FilterTree = {};
  for (const [key, value] of params) {
    if (!key.startsWith("filters[")) continue;
    const segments = [...key.slice("filters".length).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
    let node = tree;
    segments.forEach((segment, i) => {
      if (i === segments.length - 1) {
        node[segment] = value;
        return;
      }
      const next = node[segment];
      if (typeof next === "object") {
        node = next;
      } else {
        const created: FilterTree = {};
        node[segment] = created;
        node = created;
      }
    });
  }
  return tree;
}

/** Order of a row value and a filter value: numbers numerically, else as text (ISO instants and dates sort as text). */
function order(value: string | number | boolean, operand: string): number {
  if (typeof value === "number") return value - Number(operand);
  const text = String(value);
  return text < operand ? -1 : text > operand ? 1 : 0;
}

/**
 * One operator on one value. Like SQL, a comparison with a missing value
 * (NULL) is false: `blocked $ne true` does not take a user without the
 * column, which is why the web adds `$null` next to it.
 */
function applies(operator: string, value: unknown, operand: FilterTree | string): boolean {
  if (operator === "$in") {
    return (
      typeof operand === "object" &&
      value != null &&
      Object.values(operand).some((item) => typeof item === "string" && String(value) === item)
    );
  }
  if (typeof operand !== "string") return false;
  if (operator === "$null") return (value == null) === (operand === "true");
  if (operator === "$notNull") return (value != null) === (operand === "true");
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  switch (operator) {
    case "$eq":
      return String(value) === operand;
    case "$ne":
      return String(value) !== operand;
    case "$lt":
      return order(value, operand) < 0;
    case "$lte":
      return order(value, operand) <= 0;
    case "$gt":
      return order(value, operand) > 0;
    case "$gte":
      return order(value, operand) >= 0;
    case "$containsi":
      return String(value).toLowerCase().includes(operand.toLowerCase());
    default:
      warn(`unsupported filter operator ${operator}`);
      return false;
  }
}

/** Whether `value` (a row, a relation, a list of relations or a scalar) passes `tree`. */
function passes(value: unknown, tree: FilterTree): boolean {
  // A to-many relation passes when one of its rows does (a join).
  if (Array.isArray(value)) return value.some((item) => passes(item, tree));
  return Object.entries(tree).every(([key, child]) => {
    if (key === "$or" || key === "$and") {
      const branches = typeof child === "object" ? Object.values(child) : [];
      const test = (branch: FilterTree | string) =>
        typeof branch === "object" && passes(value, branch);
      return key === "$or" ? branches.some(test) : branches.every(test);
    }
    if (key.startsWith("$")) return applies(key, value, child);
    return typeof child === "object" && passes(field(value, key), child);
  });
}

/** `sort=a:desc,b` or `sort[0]=a:desc&sort[1]=b` → [["a", -1], ["b", 1]]. */
function sortSpecs(params: URLSearchParams): [string, number][] {
  const specs = [
    ...params.getAll("sort").flatMap((value) => value.split(",")),
    ...[...params]
      .filter(([key]) => /^sort\[\d+\]$/.test(key))
      .sort(([a], [b]) => Number(a.slice(5, -1)) - Number(b.slice(5, -1)))
      .map(([, value]) => value),
  ];
  return specs
    .filter((spec) => spec !== "")
    .map((spec) => {
      const [name = "", direction = "asc"] = spec.split(":");
      return [name, direction.toLowerCase() === "desc" ? -1 : 1];
    });
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The rows that pass the request's filters, in the request's sort order. */
function query<T>(rows: readonly T[], params: URLSearchParams): T[] {
  const tree = filterTree(params);
  const specs = sortSpecs(params);
  const matched = rows.filter((row) => passes(row, tree));
  return specs.length === 0
    ? matched
    : [...matched].sort((a, b) => {
        for (const [name, direction] of specs) {
          const diff = compareValues(field(a, name), field(b, name));
          if (diff !== 0) return diff * direction;
        }
        return 0;
      });
}

/** A content-type `find` answer: filtered, sorted, one page with its pagination. */
function list<T>(rows: readonly T[], params: URLSearchParams) {
  const matched = query(rows, params);
  const pageSize = Math.max(1, Number(params.get("pagination[pageSize]") ?? 25) || 25);
  const page = Math.max(1, Number(params.get("pagination[page]") ?? 1) || 1);
  return {
    data: matched.slice((page - 1) * pageSize, page * pageSize),
    meta: {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(matched.length / pageSize),
        total: matched.length,
      },
    },
  };
}

/** GET /api/users: a BARE ARRAY paged by start/limit (users-permissions). */
function userList(params: URLSearchParams): UserLite[] {
  const start = Math.max(0, Number(params.get("start") ?? 0) || 0);
  const limit = Math.max(0, Number(params.get("limit") ?? 100) || 100);
  return query(directory, params).slice(start, start + limit);
}

/** GET /api/event-rsvps/summary?targets=: the FX21 aggregate per listed event. */
function rsvpSummaries(params: URLSearchParams) {
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
        yesNames: rows.filter((row) => row.status === "yes").map((row) => row.user.displayName),
        myStatus: rows.find((row) => row.user.id === DEMO_USER_ID)?.status ?? null,
      };
    }),
  };
}

/** A poll by its address: documentId or row id (DA01). */
const pollByRef = (ref: string) => polls.find((p) => p.documentId === ref || String(p.id) === ref);

/** What Strapi answers for an unknown entry. */
const notFound = () =>
  new StrapiError(
    404,
    "Not Found",
    JSON.stringify({
      data: null,
      error: { status: 404, name: "NotFoundError", message: "Not Found" },
    }),
  );

function warn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[demo] ${message}`);
}

type Handler = (params: URLSearchParams, match: RegExpMatchArray) => unknown;

/**
 * The route table: an exact path (or pattern) per path template. Order
 * matters only where patterns overlap (a custom route before its list).
 */
const ROUTES: [RegExp, Handler][] = [
  [/^\/api\/departments$/, (p) => list(departments, p)],
  [/^\/api\/teams$/, (p) => list(teams, p)],
  [/^\/api\/wiki-spaces$/, (p) => list(wikiSpaces, p)],
  [/^\/api\/wiki-pages$/, (p) => list(wikiPages, p)],
  [/^\/api\/announcements$/, (p) => list(announcements, p)],
  [/^\/api\/acknowledgements$/, (p) => list(demoAcknowledgements, p)],
  [/^\/api\/events$/, (p) => list(events, p)],
  [/^\/api\/event-rsvps\/summary$/, (p) => rsvpSummaries(p)],
  [/^\/api\/event-rsvps$/, (p) => list(eventRsvps, p)],
  [
    /^\/api\/polls\/([^/]+)\/results$/,
    (_, match) => {
      const poll = pollByRef(decodeURIComponent(match[1]!));
      const results = poll ? pollResultsOf(poll) : null;
      if (!results) throw notFound();
      return results;
    },
  ],
  [/^\/api\/polls$/, (p) => list(polls, p)],
  [/^\/api\/kudos-entries$/, (p) => list(kudosEntries, p)],
  [/^\/api\/celebrations$/, () => ({ data: celebrations })],
  [/^\/api\/documents$/, (p) => list(documents, p)],
  [/^\/api\/classifieds$/, (p) => list(classifieds, p)],
  [/^\/api\/courses$/, (p) => list(demoCourses, p)],
  [/^\/api\/lessons$/, (p) => list(lessonRows, p)],
  [/^\/api\/lesson-progresses$/, (p) => list(demoLessonProgress, p)],
  [/^\/api\/quick-links$/, (p) => list(quickLinks, p)],
  [/^\/api\/notifications$/, (p) => list(notifications, p)],
  [/^\/api\/comments$/, (p) => list(demoComments, p)],
  [/^\/api\/reactions$/, (p) => list(demoReactions, p)],
  [/^\/api\/users$/, (p) => userList(p)],
  [/^\/api\/users\/me$/, () => directory.find((u) => u.id === DEMO_USER_ID)],
  // An unknown id answers an empty body, like the users-permissions findOne.
  [/^\/api\/users\/(\d+)$/, (_, match) => directory.find((u) => String(u.id) === match[1])],
  [/^\/api\/me$/, () => ({ data: me })],
];

/**
 * The fixture answer for a Strapi `path` (with its query string), as
 * strapi() would receive it. Throws a StrapiError where Strapi answers an
 * error (an unknown poll's results).
 */
export function demo(path: string): unknown {
  const [pathname = "", search = ""] = path.split(/\?(.*)/s);
  const params = new URLSearchParams(search);
  for (const [pattern, handler] of ROUTES) {
    const match = pathname.match(pattern);
    if (match) return handler(params, match);
  }
  warn(`no fixture for ${path}`);
  return list([], params);
}
