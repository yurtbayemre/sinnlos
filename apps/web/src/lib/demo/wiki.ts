import type { WikiPage, WikiSpace } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoWiki(users: DemoUsers, clock: DemoClock) {
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
          updatedAt: clock.ago(0),
        },
        {
          id: 102,
          title: "Remote work policy",
          slug: "remote-work",
          summary: "Our stance on flexibility, core hours and equipment.",
          body: `# Remote work policy\n\nWe trust people to do great work from wherever they are most productive.\n\n## Core principles\n\n1. **Async by default** — assume written context first\n2. **Overlap** — keep 3 hours of timezone overlap with your team\n3. **Equipment** — laptops and monitors are company-provided\n\n> "The best work happens when people are trusted."`,
          author: users.maria,
          lastEditor: users.maria,
          updatedAt: clock.ago(0),
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
          updatedAt: clock.ago(0),
        },
      ],
    },
  ] satisfies WikiSpace[];

  /** Every wiki page with its space (the /api/wiki-pages rows). */
  const wikiPages: WikiPage[] = wikiSpaces.flatMap((s) =>
    s.pages.map((p) => ({ ...p, space: { id: s.id, name: s.name, slug: s.slug } })),
  );

  return { wikiSpaces, wikiPages };
}
