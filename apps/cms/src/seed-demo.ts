/**
 * Populates the database with realistic demo data so people can explore
 * every Sinnlos feature without manual setup. Gated behind SEED_DEMO_DATA=1.
 *
 * Idempotent — skips seeding if any departments already exist (simple
 * guard against re-running on an already-populated database).
 */

const DEPARTMENTS = [
  { name: "Engineering", color: "#6366f1", description: "Software development, infrastructure, and technical architecture." },
  { name: "Design", color: "#ec4899", description: "Product design, UX research, and brand identity." },
  { name: "Marketing", color: "#f59e0b", description: "Brand strategy, content, campaigns, and analytics." },
  { name: "Human Resources", color: "#10b981", description: "People operations, recruiting, culture, and employee development." },
  { name: "Finance", color: "#3b82f6", description: "Accounting, budgeting, payroll, and financial planning." },
];

const TEAMS = [
  { name: "Frontend", department: "Engineering" },
  { name: "Backend", department: "Engineering" },
  { name: "Platform & DevOps", department: "Engineering" },
  { name: "Brand & Content", department: "Marketing" },
  { name: "UX Research", department: "Design" },
  { name: "Product Design", department: "Design" },
  { name: "Recruiting", department: "Human Resources" },
  { name: "Payroll", department: "Finance" },
];

const USERS = [
  { username: "alex.morgan", email: "alex.morgan@sinnlos.local", displayName: "Alex Morgan", jobTitle: "VP of Engineering", department: "Engineering", officeLocation: "Berlin HQ", phone: "+49 30 1234 001" },
  { username: "sam.chen", email: "sam.chen@sinnlos.local", displayName: "Sam Chen", jobTitle: "Senior Frontend Engineer", department: "Engineering", officeLocation: "Berlin HQ", phone: "+49 30 1234 002" },
  { username: "jordan.lee", email: "jordan.lee@sinnlos.local", displayName: "Jordan Lee", jobTitle: "Backend Engineer", department: "Engineering", officeLocation: "Remote", phone: "+49 30 1234 003" },
  { username: "taylor.swift", email: "taylor.s@sinnlos.local", displayName: "Taylor Swift", jobTitle: "DevOps Engineer", department: "Engineering", officeLocation: "Berlin HQ", phone: "+49 30 1234 004" },
  { username: "riley.kim", email: "riley.kim@sinnlos.local", displayName: "Riley Kim", jobTitle: "Head of Design", department: "Design", officeLocation: "Berlin HQ", phone: "+49 30 1234 005" },
  { username: "casey.jones", email: "casey.jones@sinnlos.local", displayName: "Casey Jones", jobTitle: "UX Researcher", department: "Design", officeLocation: "Munich", phone: "+49 89 5678 001" },
  { username: "jamie.garcia", email: "jamie.garcia@sinnlos.local", displayName: "Jamie Garcia", jobTitle: "Marketing Manager", department: "Marketing", officeLocation: "Berlin HQ", phone: "+49 30 1234 006" },
  { username: "quinn.wilson", email: "quinn.wilson@sinnlos.local", displayName: "Quinn Wilson", jobTitle: "Content Strategist", department: "Marketing", officeLocation: "Remote", phone: "+49 30 1234 007" },
  { username: "dana.patel", email: "dana.patel@sinnlos.local", displayName: "Dana Patel", jobTitle: "HR Director", department: "Human Resources", officeLocation: "Berlin HQ", phone: "+49 30 1234 008" },
  { username: "morgan.brooks", email: "morgan.brooks@sinnlos.local", displayName: "Morgan Brooks", jobTitle: "Finance Lead", department: "Finance", officeLocation: "Berlin HQ", phone: "+49 30 1234 009" },
];

const PASSWORD = "demo1234";

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

function daysAgo(n: number): string {
  return daysFromNow(-n);
}

export async function seedDemoData(strapi: any) {
  if (process.env.SEED_DEMO_DATA !== "1") return;

  const existingDepts = await strapi.db.query("api::department.department").count({});
  if (existingDepts > 0) {
    strapi.log.info("[seed-demo] data already exists, skipping");
    return;
  }

  strapi.log.info("[seed-demo] seeding demo data …");

  // --- Roles lookup ---
  const memberRole = await strapi.db
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "member" } });
  const editorRole = await strapi.db
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "editor" } });
  const adminRole = await strapi.db
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "admin_role" } });

  // --- Departments ---
  const deptMap: Record<string, any> = {};
  for (const d of DEPARTMENTS) {
    deptMap[d.name] = await strapi.db.query("api::department.department").create({
      data: { ...d, slug: slugify(d.name), publishedAt: new Date() },
    });
  }

  // --- Teams ---
  const teamMap: Record<string, any> = {};
  for (const t of TEAMS) {
    teamMap[t.name] = await strapi.db.query("api::team.team").create({
      data: {
        name: t.name,
        slug: slugify(t.name),
        department: deptMap[t.department].id,
        publishedAt: new Date(),
      },
    });
  }

  // --- Users ---
  const userMap: Record<string, any> = {};
  for (let i = 0; i < USERS.length; i++) {
    const u = USERS[i];
    const role = i === 0 ? adminRole : i < 5 ? editorRole : memberRole;
    const hireDate = new Date();
    hireDate.setFullYear(hireDate.getFullYear() - (USERS.length - i));
    hireDate.setMonth(i % 12);

    userMap[u.username] = await strapi
      .plugin("users-permissions")
      .service("user")
      .add({
        username: u.username,
        email: u.email,
        displayName: u.displayName,
        jobTitle: u.jobTitle,
        phone: u.phone,
        officeLocation: u.officeLocation,
        department: deptMap[u.department].id,
        provider: "local",
        password: PASSWORD,
        confirmed: true,
        blocked: false,
        role: role?.id,
        hireDate: hireDate.toISOString().slice(0, 10),
      });
  }

  // Manager hierarchy
  const alex = userMap["alex.morgan"];
  for (const name of ["sam.chen", "jordan.lee", "taylor.swift"]) {
    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: userMap[name].id },
      data: { manager: alex.id },
    });
  }
  await strapi.db.query("plugin::users-permissions.user").update({
    where: { id: userMap["casey.jones"].id },
    data: { manager: userMap["riley.kim"].id },
  });

  // Department heads
  await strapi.db.query("api::department.department").update({ where: { id: deptMap["Engineering"].id }, data: { head: alex.id } });
  await strapi.db.query("api::department.department").update({ where: { id: deptMap["Design"].id }, data: { head: userMap["riley.kim"].id } });
  await strapi.db.query("api::department.department").update({ where: { id: deptMap["Marketing"].id }, data: { head: userMap["jamie.garcia"].id } });
  await strapi.db.query("api::department.department").update({ where: { id: deptMap["Human Resources"].id }, data: { head: userMap["dana.patel"].id } });
  await strapi.db.query("api::department.department").update({ where: { id: deptMap["Finance"].id }, data: { head: userMap["morgan.brooks"].id } });

  // Team leads + members
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["Frontend"].id }, data: { lead: userMap["sam.chen"].id } });
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["Backend"].id }, data: { lead: userMap["jordan.lee"].id } });
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["Platform & DevOps"].id }, data: { lead: userMap["taylor.swift"].id } });
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["Product Design"].id }, data: { lead: userMap["riley.kim"].id } });
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["UX Research"].id }, data: { lead: userMap["casey.jones"].id } });
  await strapi.db.query("api::team.team").update({ where: { id: teamMap["Brand & Content"].id }, data: { lead: userMap["quinn.wilson"].id } });

  // --- Announcements ---
  const announcements = [
    { title: "Welcome to Sinnlos Intranet!", body: "We're excited to launch our new intranet platform. Explore the sidebar to discover all features — from the people directory and org chart to polls, kudos, and our wiki. If you have questions, drop a comment below!", pinned: true, audience: "all" as const, author: userMap["dana.patel"].id },
    { title: "Q3 All-Hands: Friday at 14:00", body: "Join us in the main conference room (or remotely) for the quarterly all-hands. Agenda: product roadmap update, hiring plan, and the new office kitchen reveal. Snacks provided!", pinned: false, audience: "all" as const, author: alex.id },
    { title: "New Design System v2 is live", body: "The design team has shipped Design System v2 with updated tokens, component variants, and dark mode support. Check the wiki for migration guides. Reach out in #design-system on Slack for questions.", pinned: false, audience: "all" as const, author: userMap["riley.kim"].id },
    { title: "Updated Travel & Expense Policy", body: "Please review the updated travel and expense policy in the Documents section. Key changes: meal per-diem increased to €50/day, economy-plus flights now approved for trips over 4 hours. Effective immediately.", pinned: false, audience: "all" as const, author: userMap["morgan.brooks"].id },
    { title: "Engineering: Sprint Retro moved to Thursday", body: "This week's sprint retro is moved from Wednesday to Thursday 16:00 to accommodate the client demo. Same room, same agenda.", pinned: false, audience: "departments" as const, author: alex.id, department: deptMap["Engineering"].id },
  ];

  const announcementEntities: any[] = [];
  for (const a of announcements) {
    announcementEntities.push(
      await strapi.db.query("api::announcement.announcement").create({
        data: { ...a, publishedAt: new Date(daysAgo(announcements.indexOf(a) * 2)) },
      }),
    );
  }

  // --- Events ---
  const events = [
    { title: "Q3 All-Hands Meeting", description: "Quarterly company all-hands with leadership updates, product demos, and Q&A.", start: daysFromNow(3), end: daysFromNow(3), location: "Main Conference Room / Zoom", organizer: alex.id },
    { title: "Design System Workshop", description: "Hands-on workshop covering the new DS v2 tokens and component library. Bring your laptop!", start: daysFromNow(7), end: daysFromNow(7), location: "Design Lab, 3rd Floor", organizer: userMap["riley.kim"].id },
    { title: "Summer Team Barbecue", description: "Annual summer barbecue on the rooftop terrace. Vegetarian and vegan options available. Families welcome!", start: daysFromNow(14), end: daysFromNow(14), allDay: true, location: "Rooftop Terrace", organizer: userMap["dana.patel"].id },
    { title: "Frontend Guild: React 19 Deep Dive", description: "Monthly frontend guild session. This time: React 19 compiler, use() hook, and Server Components patterns.", start: daysFromNow(5), end: daysFromNow(5), location: "Room 42", organizer: userMap["sam.chen"].id },
    { title: "Hiring Kickoff: Senior Backend Engineer", description: "Alignment meeting for the new Senior Backend role. We'll review the job description, interview loop, and sourcing strategy.", start: daysFromNow(2), end: daysFromNow(2), location: "HR Meeting Room", organizer: userMap["dana.patel"].id },
    { title: "Finance: Month-End Close", description: "Monthly close process. All expense reports must be submitted by EOD the day before.", start: daysFromNow(18), end: daysFromNow(19), location: "Finance Office", organizer: userMap["morgan.brooks"].id },
  ];

  for (const e of events) {
    await strapi.db.query("api::event.event").create({
      data: { ...e, publishedAt: new Date() },
    });
  }

  // --- Wiki Spaces & Pages ---
  const generalSpace = await strapi.db.query("api::wiki-space.wiki-space").create({
    data: { name: "General", slug: "general", icon: "book", description: "Company-wide knowledge base", visibility: "public", publishedAt: new Date() },
  });

  const engSpace = await strapi.db.query("api::wiki-space.wiki-space").create({
    data: { name: "Engineering", slug: "engineering", icon: "code", description: "Technical documentation and architecture decisions", visibility: "public", department: deptMap["Engineering"].id, publishedAt: new Date() },
  });

  const hrSpace = await strapi.db.query("api::wiki-space.wiki-space").create({
    data: { name: "People & Culture", slug: "people-culture", icon: "heart", description: "HR policies, onboarding guides, and culture handbook", visibility: "public", department: deptMap["Human Resources"].id, publishedAt: new Date() },
  });

  const wikiPages = [
    { title: "Getting Started", slug: "getting-started", space: generalSpace.id, author: userMap["dana.patel"].id, order: 0, body: "# Welcome to Sinnlos\n\nThis is your company intranet. Here's how to get the most out of it:\n\n## Key Features\n\n- **People Directory** — Find colleagues, view the org chart, and see who reports to whom\n- **Announcements** — Stay up to date with company news; comment and react\n- **Events** — Browse upcoming events and download calendar invites (.ics)\n- **Wiki** — Browse and contribute to our knowledge base\n- **Kudos** — Recognize colleagues for great work\n- **Polls** — Vote on company decisions\n- **Documents** — Access policies, forms, and templates\n\n## Need Help?\n\nReach out to the HR team or drop a comment on any announcement." },
    { title: "Code Review Guidelines", slug: "code-review-guidelines", space: engSpace.id, author: userMap["sam.chen"].id, order: 0, body: "# Code Review Guidelines\n\n## Philosophy\n\nCode reviews are about **knowledge sharing** first and quality second. Every review is a learning opportunity.\n\n## Expectations\n\n- Respond to review requests within **4 business hours**\n- Keep PRs under **400 lines** when possible\n- Use conventional comments: `nit:`, `suggestion:`, `question:`, `blocker:`\n\n## What to Look For\n\n1. **Correctness** — Does it do what the ticket says?\n2. **Security** — Any injection vectors, leaked secrets, missing auth checks?\n3. **Performance** — N+1 queries, unbounded loops, missing indexes?\n4. **Readability** — Could a new team member understand this in 6 months?\n\n## Approval\n\nOne approval required; two for infrastructure or auth changes." },
    { title: "Architecture Decision Records", slug: "architecture-decision-records", space: engSpace.id, author: alex.id, order: 1, body: "# Architecture Decision Records (ADRs)\n\n## ADR-001: Strapi v5 as Headless CMS\n\n**Status:** Accepted\n\n**Context:** We need a content management backend that supports custom content types, role-based access, and can be self-hosted.\n\n**Decision:** Use Strapi v5 with PostgreSQL. The Document Service API gives us the flexibility for custom business logic while the admin panel provides a no-code editing experience for non-developers.\n\n**Consequences:** Tied to Node.js runtime for the CMS. Custom controllers needed for complex permissions beyond Strapi's built-in RBAC.\n\n---\n\n## ADR-002: Next.js for the Frontend\n\n**Status:** Accepted\n\n**Context:** We want server-side rendering for SEO-irrelevant pages too, because SSR gives us server-side auth checks and reduces client bundle size.\n\n**Decision:** Next.js with App Router and React Server Components. Auth.js (NextAuth v5) for authentication.\n\n**Consequences:** Requires Node.js runtime (no static export). Server Components simplify data fetching but limit interactivity to client component islands." },
    { title: "Onboarding Checklist", slug: "onboarding-checklist", space: hrSpace.id, author: userMap["dana.patel"].id, order: 0, body: "# New Employee Onboarding\n\n## Week 1\n\n- [ ] Sign into the intranet and update your profile\n- [ ] Meet your manager and set up 1:1 cadence\n- [ ] Read the Employee Handbook (see Documents)\n- [ ] Complete IT security training\n- [ ] Join relevant department and team channels\n\n## Week 2\n\n- [ ] Shadow a colleague on a real task\n- [ ] Attend your first team standup\n- [ ] Give your first Kudos to someone who helped you\n\n## Month 1\n\n- [ ] Complete your first project or contribution\n- [ ] Set Q-goals with your manager\n- [ ] Attend an all-hands meeting" },
    { title: "Remote Work Policy", slug: "remote-work-policy", space: hrSpace.id, author: userMap["dana.patel"].id, order: 1, body: "# Remote Work Policy\n\n## Overview\n\nWe trust our team to work from wherever they're most productive. This policy sets expectations for remote work.\n\n## Guidelines\n\n- **Core hours:** 10:00–15:00 CET — be available for meetings and collaboration\n- **Office days:** Teams may agree on 1–2 anchor days per week; no company-wide mandate\n- **Equipment:** We provide a €1,000 home-office budget (one-time, reimbursed)\n- **Communication:** Default to async. Use meetings only when async would take 3x longer\n\n## Expectations\n\n- Keep your calendar up to date\n- Respond to messages within 4 hours during core hours\n- Use video for 1:1s and team ceremonies\n\n## Coworking\n\nNeed a change of scenery? We reimburse up to €200/month for coworking spaces. Submit receipts via the expense form in Documents." },
  ];

  for (const p of wikiPages) {
    await strapi.db.query("api::wiki-page.wiki-page").create({
      data: { ...p, publishedAt: new Date() },
    });
  }

  // --- Kudos ---
  const kudosList = [
    { from: userMap["sam.chen"].id, to: userMap["jordan.lee"].id, message: "Jordan completely rebuilt our API caching layer over the weekend to fix the performance issue. Response times dropped by 80%. Incredible work!", value: "excellence" },
    { from: userMap["riley.kim"].id, to: userMap["casey.jones"].id, message: "The usability study Casey ran this week surfaced three critical issues we would've shipped to production. Saved us weeks of bug reports!", value: "innovation" },
    { from: userMap["dana.patel"].id, to: alex.id, message: "Alex mentored two junior engineers through their first production deployments this sprint. Both shipped with zero incidents. That's leadership!", value: "leadership" },
    { from: userMap["jordan.lee"].id, to: userMap["sam.chen"].id, message: "Sam paired with me for two full days to unblock the SSR migration. Truly a team player.", value: "teamwork" },
    { from: userMap["quinn.wilson"].id, to: userMap["jamie.garcia"].id, message: "Jamie's last-minute campaign pivot for the product launch was brilliant. We hit 150% of our signup target!", value: "customer-focus" },
    { from: alex.id, to: userMap["taylor.swift"].id, message: "Taylor migrated our entire CI pipeline to the new runner in one afternoon with zero downtime. Chef's kiss.", value: "excellence" },
    { from: userMap["morgan.brooks"].id, to: userMap["dana.patel"].id, message: "Dana streamlined the onboarding process and cut new-hire ramp-up time by two weeks. The new checklist is fantastic.", value: "innovation" },
    { from: userMap["casey.jones"].id, to: userMap["riley.kim"].id, message: "Riley's design system workshop was the best internal training I've attended. Clear, practical, and everyone left with something to apply immediately.", value: "leadership" },
  ];

  for (const k of kudosList) {
    await strapi.db.query("api::kudos.kudos").create({
      data: k,
    });
  }

  // --- Polls ---
  const polls = [
    { question: "Which day works best for weekly team lunch?", options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], author: userMap["dana.patel"].id, closesAt: daysFromNow(7) },
    { question: "Should we adopt a 4-day work week trial?", options: ["Yes, let's try it for Q4", "Maybe, need more details first", "No, I prefer the current schedule"], author: alex.id, closesAt: daysFromNow(14) },
    { question: "Preferred tech talk format?", options: ["30-min lightning talks", "60-min deep dives", "Mix of both", "Recorded async videos"], author: userMap["sam.chen"].id, anonymous: true, closesAt: daysFromNow(10) },
  ];

  const pollEntities: any[] = [];
  for (const p of polls) {
    pollEntities.push(
      await strapi.db.query("api::poll.poll").create({
        data: { ...p, publishedAt: new Date() },
      }),
    );
  }

  // Some sample votes
  const voters = Object.values(userMap);
  for (let i = 0; i < voters.length && i < 7; i++) {
    await strapi.db.query("api::poll-vote.poll-vote").create({
      data: { poll: pollEntities[0].id, optionIndex: i % 5, voter: (voters[i] as any).id },
    });
  }
  for (let i = 0; i < 5; i++) {
    await strapi.db.query("api::poll-vote.poll-vote").create({
      data: { poll: pollEntities[1].id, optionIndex: i % 3, voter: (voters[i] as any).id },
    });
  }

  // --- Documents ---
  const documents = [
    { title: "Employee Handbook 2024", description: "Comprehensive guide covering company policies, benefits, and expectations.", category: "policy", uploadedBy: userMap["dana.patel"].id },
    { title: "Expense Report Template", description: "Standard template for submitting travel and business expenses.", category: "form", uploadedBy: userMap["morgan.brooks"].id },
    { title: "Brand Guidelines", description: "Logo usage, color palette, typography, and tone of voice.", category: "guide", uploadedBy: userMap["jamie.garcia"].id },
    { title: "Architecture Diagram Template", description: "Mermaid-based template for documenting system architecture.", category: "template", uploadedBy: alex.id },
    { title: "Information Security Policy", description: "Data classification, access controls, incident response procedures.", category: "policy", uploadedBy: userMap["dana.patel"].id },
    { title: "Meeting Notes Template", description: "Standard template for recording meeting agendas, decisions, and action items.", category: "template", uploadedBy: userMap["quinn.wilson"].id },
  ];

  for (const d of documents) {
    await strapi.db.query("api::document.document").create({
      data: { ...d, publishedAt: new Date() },
    });
  }

  // --- Comments on announcements ---
  const comments = [
    { body: "This is great! Love the new platform. The search is super fast.", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["sam.chen"].id },
    { body: "Really nice work everyone. Quick question — can we customize the sidebar nav?", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["casey.jones"].id },
    { body: "Will this be recorded? I have a conflict with a client call.", targetType: "announcement", targetId: announcementEntities[1].id, author: userMap["quinn.wilson"].id },
    { body: "Yes, we'll record and post the link here afterwards!", targetType: "announcement", targetId: announcementEntities[1].id, author: alex.id },
    { body: "The dark mode support is amazing. Huge quality-of-life improvement.", targetType: "announcement", targetId: announcementEntities[2].id, author: userMap["jordan.lee"].id },
  ];

  for (const c of comments) {
    await strapi.db.query("api::comment.comment").create({
      data: c,
    });
  }

  // --- Reactions on announcements ---
  const reactions = [
    { emoji: "thumbsup", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["sam.chen"].id },
    { emoji: "heart", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["riley.kim"].id },
    { emoji: "celebrate", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["jordan.lee"].id },
    { emoji: "celebrate", targetType: "announcement", targetId: announcementEntities[0].id, author: userMap["casey.jones"].id },
    { emoji: "thumbsup", targetType: "announcement", targetId: announcementEntities[1].id, author: userMap["dana.patel"].id },
    { emoji: "lightbulb", targetType: "announcement", targetId: announcementEntities[2].id, author: userMap["sam.chen"].id },
    { emoji: "thumbsup", targetType: "announcement", targetId: announcementEntities[2].id, author: userMap["taylor.swift"].id },
    { emoji: "heart", targetType: "announcement", targetId: announcementEntities[2].id, author: alex.id },
    { emoji: "thumbsup", targetType: "announcement", targetId: announcementEntities[3].id, author: userMap["quinn.wilson"].id },
  ];

  for (const r of reactions) {
    await strapi.db.query("api::reaction.reaction").create({
      data: r,
    });
  }

  strapi.log.info(
    `[seed-demo] done — ${USERS.length} users (password: "${PASSWORD}"), ` +
    `${DEPARTMENTS.length} departments, ${TEAMS.length} teams, ` +
    `${announcements.length} announcements, ${events.length} events, ` +
    `${wikiPages.length} wiki pages, ${kudosList.length} kudos, ` +
    `${polls.length} polls, ${documents.length} documents`,
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
