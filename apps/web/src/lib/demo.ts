/**
 * In-memory demo dataset used when DEMO_MODE=1, so the UI can be
 * previewed without a running Strapi instance. The shapes match what
 * Strapi v5 flat responses return.
 */
type AnyEntry = { id: number; [key: string]: any };
type ListResponse = { data: AnyEntry[]; meta: { pagination: any } };

const pack = (data: AnyEntry[]): ListResponse => ({
  data,
  meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: data.length } },
});

const users: Record<string, AnyEntry> = {
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
};

const departments: AnyEntry[] = [
  {
    id: 1,
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
];

const teams: AnyEntry[] = departments.flatMap((d) =>
  d.teams.map((t: AnyEntry) => ({
    ...t,
    department: { id: d.id, name: d.name, slug: d.slug },
    lead: d.head,
    members: d.members,
  })),
);

const wikiSpaces: AnyEntry[] = [
  {
    id: 1,
    name: "Handbook",
    slug: "handbook",
    icon: "book",
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
    icon: "code",
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
];

const announcements: AnyEntry[] = [
  {
    id: 1,
    documentId: "demo-ann-1",
    title: "Q2 All-hands this Friday",
    requiresAck: true,
    ackDeadline: new Date(Date.now() + 7 * 86400000).toISOString(),
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
];

/**
 * Fixtures for the modules added after the original demo set (issue #15):
 * kudos, polls, events + RSVPs, documents, notifications, quick links,
 * marketplace, celebrations. Shapes mirror the real API responses the
 * pages consume — dates are computed relative to "now" so the events
 * month view and expiry filters always show content.
 */
const day = 86400000;
const iso = (offsetDays: number, hour = 10) => {
  const d = new Date(Date.now() + offsetDays * day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
const dateOnly = (offsetDays: number) => iso(offsetDays).slice(0, 10);

const events: AnyEntry[] = [
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
];

const eventRsvps: AnyEntry[] = [
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
];

const polls: AnyEntry[] = [
  {
    id: 1,
    documentId: "demo-poll-1",
    question: "Where should the winter offsite happen?",
    options: ["Mountains (ski + sauna)", "City trip (Lisbon)", "Countryside retreat"],
    closesAt: iso(5),
    anonymous: false,
    author: users.maria,
    departments: [],
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
    departments: [{ id: 1, name: "Engineering", slug: "engineering" }],
    createdAt: iso(-9),
  },
];

const pollResults: Record<number, unknown> = {
  1: {
    poll: {
      id: 1,
      question: polls[0].question,
      options: polls[0].options,
      closesAt: polls[0].closesAt,
      anonymous: false,
    },
    counts: [9, 6, 4],
    total: 19,
    myVoteIndex: null,
  },
  2: {
    poll: {
      id: 2,
      question: polls[1].question,
      options: polls[1].options,
      closesAt: polls[1].closesAt,
      anonymous: true,
    },
    counts: [14, 5, 1],
    total: 20,
    myVoteIndex: 0,
  },
};

const kudosEntries: AnyEntry[] = [
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
];

const celebrations: AnyEntry[] = [
  { id: 1, user: users.jonas, type: "birthday", date: dateOnly(2), daysUntil: 2 },
  { id: 2, user: users.grace, type: "work-anniversary", years: 3, daysUntil: 9 },
];

const documents: AnyEntry[] = [
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
];

const classifieds: AnyEntry[] = [
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
];

const quickLinks: AnyEntry[] = [
  { id: 1, label: "HR portal", url: "https://example.com/hr", icon: "Contact", order: 1 },
  { id: 2, label: "Expense tool", url: "https://example.com/expenses", icon: "Wallet", order: 2 },
  { id: 3, label: "IT helpdesk", url: "https://example.com/helpdesk", icon: "LifeBuoy", order: 3 },
  { id: 4, label: "Meeting rooms", url: "https://example.com/rooms", icon: "Calendar", order: 4 },
  { id: 5, label: "Status page", url: "https://status.example.com", icon: "Globe", order: 5 },
];

const notifications: AnyEntry[] = [
  {
    id: 1,
    type: "comment",
    title: 'Grace Hopper commented on "Q2 All-hands this Friday"',
    link: "/announcements",
    readAt: null,
    createdAt: iso(0, 8),
    actor: users.grace,
  },
  {
    id: 2,
    type: "kudos",
    title: "Sofia Martín sent you kudos",
    link: "/kudos",
    readAt: null,
    createdAt: iso(-1),
    actor: users.sofia,
  },
  {
    id: 3,
    type: "announcement",
    title: "New announcement: Engineering handbook v2 published",
    link: "/announcements",
    readAt: iso(-2),
    createdAt: iso(-2),
    actor: users.linus,
  },
];

const demoComments: AnyEntry[] = [
  {
    id: 1,
    body: "Will the session be recorded for the folks on parental leave?",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.grace,
    createdAt: iso(-1, 9),
    replies: [],
  },
  {
    id: 2,
    body: "Yes — recording lands in the wiki right after. 🎥",
    targetType: "announcement",
    targetDocumentId: "demo-ann-1",
    author: users.maria,
    createdAt: iso(-1, 11),
    replies: [],
  },
  {
    id: 3,
    body: "The new search filters are a game changer, thanks team!",
    targetType: "announcement",
    targetDocumentId: "demo-ann-2",
    author: users.jonas,
    createdAt: iso(0, 7),
    replies: [],
  },
];

const demoReactions: AnyEntry[] = [
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
];

const demoLessons: AnyEntry[] = [
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
];

const demoCourses: AnyEntry[] = [
  {
    id: 1,
    documentId: "demo-course-1",
    title: "Security awareness basics",
    slug: "security-awareness-basics",
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
];

const demoLessonProgress: AnyEntry[] = [
  { id: 1, targetDocumentId: "demo-lesson-1", completedAt: iso(-2) },
];

/** Value of a query param inside the raw path, or null. */
function param(path: string, key: string): string | null {
  const m = path.match(new RegExp(`[?&]${key.replace(/[[\]$]/g, "\\$&")}=([^&]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

function findBy<T extends AnyEntry>(items: T[], slug: string): T | undefined {
  return items.find((i) => i.slug === slug);
}

export function demo(path: string): unknown {
  // /api/departments → list
  if (path.startsWith("/api/departments?filters[slug][$eq]=")) {
    const slug = decodeURIComponent(path.split("filters[slug][$eq]=")[1]!.split("&")[0]!);
    const hit = findBy(departments, slug);
    return pack(hit ? [hit] : []);
  }
  if (path.startsWith("/api/departments")) return pack(departments);

  if (path.startsWith("/api/teams?filters[slug][$eq]=")) {
    const slug = decodeURIComponent(path.split("filters[slug][$eq]=")[1]!.split("&")[0]!);
    const hit = findBy(teams, slug);
    return pack(hit ? [hit] : []);
  }
  if (path.startsWith("/api/teams")) return pack(teams);

  if (path.startsWith("/api/wiki-spaces?filters[slug][$eq]=")) {
    const slug = decodeURIComponent(path.split("filters[slug][$eq]=")[1]!.split("&")[0]!);
    const hit = findBy(wikiSpaces, slug);
    return pack(hit ? [hit] : []);
  }
  if (path.startsWith("/api/wiki-spaces")) return pack(wikiSpaces);

  if (path.startsWith("/api/wiki-pages?filters[space][slug][$eq]=")) {
    const spaceSlug = decodeURIComponent(
      path.split("filters[space][slug][$eq]=")[1]!.split("&")[0]!,
    );
    const pageSlug = decodeURIComponent(path.split("filters[slug][$eq]=")[1]!.split("&")[0]!);
    const space = findBy(wikiSpaces, spaceSlug);
    const page = space?.pages?.find((p: AnyEntry) => p.slug === pageSlug);
    return pack(page ? [{ ...page, space }] : []);
  }
  if (path.startsWith("/api/wiki-pages")) {
    const allPages = wikiSpaces.flatMap((s) =>
      (s.pages ?? []).map((p: AnyEntry) => ({
        ...p,
        space: { id: s.id, name: s.name, slug: s.slug },
      })),
    );
    return pack(allPages);
  }

  if (path.startsWith("/api/announcements")) {
    // The requiresAck probe (dashboard banner + announcements page) filters
    // on requiresAck=true — return only those there.
    if (param(path, "filters[requiresAck][$eq]") === "true")
      return pack(announcements.filter((a) => a.requiresAck));
    return pack(announcements);
  }

  // /api/users is the users-permissions plugin: it answers with a PLAIN
  // ARRAY (no data/meta envelope) — users.ts pages it via start/limit.
  if (path.startsWith("/api/users")) {
    const start = Number(param(path, "start") ?? 0);
    return start > 0
      ? []
      : Object.values(users).map((u) => ({
          ...u,
          department: departments[0]
            ? { id: departments[0].id, name: departments[0].name, slug: departments[0].slug }
            : null,
        }));
  }

  if (path.startsWith("/api/events")) {
    const id = param(path, "filters[id][$eq]");
    if (id) return pack(events.filter((e) => String(e.id) === id));
    return pack([...events].sort((a, b) => a.start.localeCompare(b.start)));
  }
  if (path.startsWith("/api/event-rsvps")) {
    const target = param(path, "filters[targetDocumentId][$eq]");
    return pack(target ? eventRsvps.filter((r) => r.targetDocumentId === target) : eventRsvps);
  }

  // /api/polls/:id/results is a custom route with its own (non-list) shape.
  const resultsMatch = path.match(/^\/api\/polls\/(\d+)\/results/);
  if (resultsMatch) return pollResults[Number(resultsMatch[1])] ?? pollResults[1];
  if (path.startsWith("/api/polls")) return pack(polls);

  if (path.startsWith("/api/kudos-entries")) return pack(kudosEntries);
  if (path.startsWith("/api/celebrations")) return pack(celebrations);
  if (path.startsWith("/api/documents")) return pack(documents);

  if (path.startsWith("/api/classifieds")) {
    const id = param(path, "filters[id][$eq]");
    if (id) return pack(classifieds.filter((c) => String(c.id) === id));
    // "my ads" filter — the demo session has no user, show nothing there.
    if (param(path, "filters[author][id][$eq]")) return pack([]);
    return pack(classifieds);
  }

  if (path.startsWith("/api/courses")) {
    const slug = param(path, "filters[slug][$eq]");
    if (slug) return pack(demoCourses.filter((c) => c.slug === slug));
    return pack(demoCourses);
  }
  if (path.startsWith("/api/lessons")) {
    const docId = param(path, "filters[documentId][$eq]");
    const all = demoCourses.flatMap((c) =>
      (c.lessons ?? []).map((l: AnyEntry) => ({
        ...l,
        course: { id: c.id, documentId: c.documentId, title: c.title, slug: c.slug },
      })),
    );
    return pack(docId ? all.filter((l) => l.documentId === docId) : all);
  }
  if (path.startsWith("/api/lesson-progresses")) return pack(demoLessonProgress);

  if (path.startsWith("/api/quick-links")) return pack(quickLinks);
  if (path.startsWith("/api/notifications")) return pack(notifications);
  if (path.startsWith("/api/acknowledgements")) return pack([]);

  if (path.startsWith("/api/comments")) {
    const target = param(path, "filters[targetDocumentId][$eq]");
    return pack(target ? demoComments.filter((c) => c.targetDocumentId === target) : demoComments);
  }
  if (path.startsWith("/api/reactions")) {
    const target = param(path, "filters[targetDocumentId][$eq]");
    return pack(
      target ? demoReactions.filter((r) => r.targetDocumentId === target) : demoReactions,
    );
  }

  // Profile page: { data: <user> } envelope.
  if (path.startsWith("/api/me")) {
    return {
      data: {
        ...users.ada,
        department: { id: 1, name: "Engineering", slug: "engineering" },
        birthdayVisible: false,
      },
    };
  }

  return pack([]);
}
