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
    title: "Q2 All-hands this Friday",
    body: "Join us at 15:00 CET in the main auditorium or on Teams. Agenda: quarterly numbers, product roadmap, and a live demo of the new intranet.",
    pinned: true,
    createdAt: new Date().toISOString(),
    author: users.maria,
  },
  {
    id: 2,
    title: "New wiki search is live",
    body: "Hit ⌘K anywhere in the app to fuzzy search wiki pages, people and teams. Special filters: `in:handbook`, `by:@grace`, `tag:runbook`.",
    pinned: true,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    author: users.ada,
  },
  {
    id: 3,
    title: "Office closed Mon 2026-05-01",
    body: "Public holiday. Remote work as usual. On-call rotation is unchanged — please check your PagerDuty schedule.",
    pinned: false,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    author: users.jonas,
  },
  {
    id: 4,
    title: "Welcome Sofia to Marketing",
    body: "Sofia Martín joins us this week as Head of Marketing, coming from a background in brand and growth at two previous startups.",
    pinned: false,
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    author: users.maria,
  },
  {
    id: 5,
    title: "Infra maintenance window: Sat 02:00–04:00 CET",
    body: "Platform team will be upgrading Postgres and rotating TLS certificates. Expect brief blips on API calls during the window.",
    pinned: false,
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    author: users.grace,
  },
  {
    id: 6,
    title: "Engineering handbook v2 published",
    body: "New sections on incident response, ADR workflow, and our updated code review checklist. Read it in the Wiki → Engineering space.",
    pinned: false,
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    author: users.linus,
  },
];

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
    const pageSlug = decodeURIComponent(
      path.split("filters[slug][$eq]=")[1]!.split("&")[0]!,
    );
    const space = findBy(wikiSpaces, spaceSlug);
    const page = space?.pages?.find((p: AnyEntry) => p.slug === pageSlug);
    return pack(page ? [{ ...page, space }] : []);
  }

  if (path.startsWith("/api/announcements")) return pack(announcements);

  return pack([]);
}
