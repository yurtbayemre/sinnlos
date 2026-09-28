import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Caller,
  type Params,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * What every role reads through the read policies, as one snapshot per
 * seeded intranet (PL02/PL04 rehearsal, batch 9): list and detail answers of
 * every policy-guarded read route, the comment and reaction threads of every
 * target through the web's single-anchor filter, and the own-rows lists.
 * The snapshot was recorded on the code before the policy factories, the
 * single-anchor fast path and the bind-limit guards (batch/8 5f2eac0); the
 * refactor must leave it byte-identical, on SQLite and on Postgres.
 *
 * Labels, not ids: numeric ids and documentIds differ per boot, so every row
 * is reported by the marker text the seed wrote (titles, names, bodies) or,
 * for rows without text, by the label of the document it anchors to. Rows
 * without a marker (the announcement fan-out's notifications, lifecycle
 * revisions) are left out, so the snapshot does not depend on when a
 * post-commit task ran.
 */

const SNAPSHOT = "../__snapshots__/role-read-snapshot.txt";

const ROLE = "plugin::users-permissions.role";

/** The fixture roles, a member of the other department, and nobody. */
const CALLERS = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
  "authenticated",
  "sales_member",
  "anonymous",
] as const;
type CallerName = (typeof CALLERS)[number];

interface Endpoint {
  path: string;
  /** The label of one returned row, or null when it carries no marker. */
  label(row: Params, labelOf: (documentId: unknown) => string | null): string | null;
}

const text =
  (field: string, prefix: string) =>
  (row: Params): string | null => {
    const value = row[field];
    return typeof value === "string" && value.startsWith(prefix) ? value : null;
  };

const anchored =
  (tag: string, extra?: string) =>
  (row: Params, labelOf: (documentId: unknown) => string | null): string | null => {
    const target = labelOf(row.targetDocumentId);
    if (target === null) return null;
    const suffix = extra ? `:${String(row[extra])}` : "";
    return `${tag}${suffix}@${target}`;
  };

const LISTS: Record<string, Endpoint> = {
  announcements: { path: "/api/announcements", label: text("title", "S:ann:") },
  documents: { path: "/api/documents", label: text("title", "S:doc:") },
  "quick-links": { path: "/api/quick-links", label: text("label", "S:ql:") },
  "wiki-spaces": { path: "/api/wiki-spaces", label: text("name", "S:space:") },
  "wiki-pages": { path: "/api/wiki-pages", label: text("title", "S:page:") },
  "wiki-revisions": { path: "/api/wiki-revisions", label: text("summary", "S:rev:") },
  polls: { path: "/api/polls", label: text("question", "S:poll:") },
  courses: { path: "/api/courses", label: text("title", "S:course:") },
  lessons: { path: "/api/lessons", label: text("title", "S:lesson:") },
  comments: { path: "/api/comments", label: text("body", "S:c:") },
  reactions: { path: "/api/reactions", label: anchored("reaction", "emoji") },
  notifications: { path: "/api/notifications", label: text("title", "S:note:") },
  acknowledgements: { path: "/api/acknowledgements", label: anchored("ack") },
  "lesson-progresses": { path: "/api/lesson-progresses", label: anchored("progress") },
  "event-rsvps": { path: "/api/event-rsvps", label: anchored("rsvp", "status") },
};

type Answer = number | string[];
type Snapshot = Record<string, Record<string, Answer>>;

interface Seeded {
  /** documentId → label, for the anchored rows. */
  labels: Map<string, string>;
  /** Comment and reaction targets, by label. */
  targets: { label: string; targetType: "announcement" | "wiki-page"; documentId: string }[];
  /** Detail routes to probe: plural → { label → documentId }. */
  details: Record<string, Record<string, string>>;
  salesMember: { username: string; password: string };
}

interface NotifyModule {
  __fanoutsSettledForTest(): Promise<void>;
}

async function seed(t: TestStrapi): Promise<Seeded> {
  const docs = (uid: string) => t.strapi.documents(uid);
  const labels = new Map<string, string>();
  const details: Seeded["details"] = {};
  const { engineering, sales } = t.fixtures.departments;
  const platform = t.fixtures.teams.platform;
  const users = t.fixtures.users;

  const memberRole = await t.strapi.db.query(ROLE).findOne({ where: { type: "member" } });
  if (!memberRole) throw new Error("member role missing");

  const create = async (
    uid: string,
    plural: string,
    label: string,
    data: Params,
    status: "draft" | "published" = "published",
  ): Promise<Row> => {
    const row = await docs(uid).create({ data, status });
    labels.set(row.documentId, label);
    (details[plural] ??= {})[label] = row.documentId;
    return row;
  };

  // A member of the other department.
  const salesPassword = "Snapshot-Sales-1";
  const salesUser = (await (
    t.strapi.plugin("users-permissions").service("user") as { add(v: Params): Promise<Row> }
  ).add({
    username: "it-sales-member",
    email: "it-sales-member@integration.test",
    displayName: "Fixture sales member",
    provider: "local",
    password: salesPassword,
    confirmed: true,
    blocked: false,
    role: memberRole.id,
    department: sales.id,
  })) as Row;

  // Announcements: every targeting criterion, a draft, a widened draft.
  const ANN = "api::announcement.announcement";
  const annAll = await create(ANN, "announcements", "S:ann:all", {
    title: "S:ann:all",
    audience: "all",
  });
  const annEng = await create(ANN, "announcements", "S:ann:eng", {
    title: "S:ann:eng",
    audience: "departments",
    department: engineering.documentId,
  });
  const annSales = await create(ANN, "announcements", "S:ann:sales", {
    title: "S:ann:sales",
    audience: "departments",
    department: sales.documentId,
  });
  const annTeam = await create(ANN, "announcements", "S:ann:team", {
    title: "S:ann:team",
    team: platform.documentId,
  });
  const annRole = await create(ANN, "announcements", "S:ann:role-member", {
    title: "S:ann:role-member",
    audienceRoles: [memberRole.documentId],
  });
  const annEngTeam = await create(ANN, "announcements", "S:ann:eng-team", {
    title: "S:ann:eng-team",
    department: engineering.documentId,
    team: platform.documentId,
  });
  const annDraft = await create(
    ANN,
    "announcements",
    "S:ann:draft",
    { title: "S:ann:draft", audience: "all" },
    "draft",
  );
  const annWidened = await create(ANN, "announcements", "S:ann:widened-draft", {
    title: "S:ann:widened-draft",
    department: engineering.documentId,
  });
  // The draft drops the department; the published row stays Engineering-only.
  await docs(ANN).update({ documentId: annWidened.documentId, data: { department: null } });

  // Documents and quick links: company-wide or per department.
  const DOC = "api::document.document";
  await create(DOC, "documents", "S:doc:all", { title: "S:doc:all" });
  await create(DOC, "documents", "S:doc:eng", {
    title: "S:doc:eng",
    departments: [engineering.documentId],
  });
  await create(DOC, "documents", "S:doc:sales", {
    title: "S:doc:sales",
    departments: [sales.documentId],
  });
  await create(DOC, "documents", "S:doc:draft", { title: "S:doc:draft" }, "draft");
  const QL = "api::quick-link.quick-link";
  await create(QL, "quick-links", "S:ql:all", {
    label: "S:ql:all",
    url: "https://intranet.invalid/a",
  });
  await create(QL, "quick-links", "S:ql:eng", {
    label: "S:ql:eng",
    url: "https://intranet.invalid/e",
    departments: [engineering.documentId],
  });
  await create(QL, "quick-links", "S:ql:sales", {
    label: "S:ql:sales",
    url: "https://intranet.invalid/s",
    departments: [sales.documentId],
  });

  // Wiki: one space per visibility, a page and a revision in each.
  const SPACE = "api::wiki-space.wiki-space";
  const PAGE = "api::wiki-page.wiki-page";
  const REVISION = "api::wiki-revision.wiki-revision";
  const spaces: [string, Params][] = [
    ["public", { visibility: "public" }],
    ["role-member", { visibility: "role", allowedRoles: [memberRole.documentId] }],
    ["dept-eng", { visibility: "department", department: engineering.documentId }],
    ["dept-sales", { visibility: "department", department: sales.documentId }],
    ["team", { visibility: "team", team: platform.documentId }],
  ];
  const pages: Row[] = [];
  for (const [key, data] of spaces) {
    const space = await create(SPACE, "wiki-spaces", `S:space:${key}`, {
      name: `S:space:${key}`,
      slug: `s-space-${key}`,
      ...data,
    });
    const page = await create(PAGE, "wiki-pages", `S:page:${key}`, {
      title: `S:page:${key}`,
      slug: `s-page-${key}`,
      space: space.documentId,
    });
    pages.push(page);
    await create(REVISION, "wiki-revisions", `S:rev:${key}`, {
      summary: `S:rev:${key}`,
      page: page.documentId,
    });
  }
  await create(
    SPACE,
    "wiki-spaces",
    "S:space:draft",
    { name: "S:space:draft", slug: "s-space-draft", visibility: "public" },
    "draft",
  );
  const publicSpace = details["wiki-spaces"]["S:space:public"];
  const draftPage = await create(
    PAGE,
    "wiki-pages",
    "S:page:draft",
    { title: "S:page:draft", slug: "s-page-draft", space: publicSpace },
    "draft",
  );
  pages.push(draftPage);

  // Polls: company-wide, per department, for guests, a draft.
  const POLL = "api::poll.poll";
  const options = ["yes", "no"];
  await create(POLL, "polls", "S:poll:all", { question: "S:poll:all", options, audience: "all" });
  await create(POLL, "polls", "S:poll:eng", {
    question: "S:poll:eng",
    options,
    audience: "departments",
    departments: [engineering.documentId],
  });
  await create(POLL, "polls", "S:poll:sales", {
    question: "S:poll:sales",
    options,
    audience: "departments",
    departments: [sales.documentId],
  });
  await create(POLL, "polls", "S:poll:guests", {
    question: "S:poll:guests",
    options,
    audience: "all",
    visibleToGuests: true,
  });
  await create(POLL, "polls", "S:poll:draft", { question: "S:poll:draft", options }, "draft");

  // Training: a published course with a published and a draft lesson, a
  // draft course with a lesson.
  const COURSE = "api::course.course";
  const LESSON = "api::lesson.lesson";
  const course = await create(COURSE, "courses", "S:course:published", {
    title: "S:course:published",
    slug: "s-course-published",
  });
  const draftCourse = await create(
    COURSE,
    "courses",
    "S:course:draft",
    { title: "S:course:draft", slug: "s-course-draft" },
    "draft",
  );
  const lesson = await create(LESSON, "lessons", "S:lesson:published", {
    title: "S:lesson:published",
    course: course.documentId,
  });
  const draftLesson = await create(
    LESSON,
    "lessons",
    "S:lesson:draft",
    { title: "S:lesson:draft", course: course.documentId },
    "draft",
  );
  await create(LESSON, "lessons", "S:lesson:in-draft-course", {
    title: "S:lesson:in-draft-course",
    course: draftCourse.documentId,
  });

  // Comments and one reaction on every target, written past the controllers.
  const announcements = [
    annAll,
    annEng,
    annSales,
    annTeam,
    annRole,
    annEngTeam,
    annDraft,
    annWidened,
  ];
  const targets: Seeded["targets"] = [
    ...announcements.map((row) => ({
      label: labels.get(row.documentId) ?? "?",
      targetType: "announcement" as const,
      documentId: row.documentId,
    })),
    ...pages.map((row) => ({
      label: labels.get(row.documentId) ?? "?",
      targetType: "wiki-page" as const,
      documentId: row.documentId,
    })),
  ];
  for (const target of targets) {
    await t.strapi.db.query("api::comment.comment").create({
      data: {
        body: `S:c:${target.label}`,
        targetType: target.targetType,
        targetDocumentId: target.documentId,
        author: users.member.id,
      },
    });
    await t.strapi.db.query("api::reaction.reaction").create({
      data: {
        emoji: "heart",
        targetType: target.targetType,
        targetDocumentId: target.documentId,
        author: users.member.id,
      },
    });
  }

  // Personal rows: each owner anchors on a different target.
  const now = "2026-09-28T08:00:00.000Z";
  const personal: [number, string][] = [
    [users.member.id, "member"],
    [salesUser.id, "sales"],
    [users.guest.id, "guest"],
    [users.admin_role.id, "admin"],
    [users.editor.id, "editor"],
  ];
  for (const [recipient, name] of personal) {
    await t.strapi.db.query("api::notification.notification").create({
      data: { type: "comment", title: `S:note:${name}`, recipient },
    });
  }
  const ack = (user: number, target: Row) =>
    t.strapi.db.query("api::acknowledgement.acknowledgement").create({
      data: {
        user,
        targetType: "announcement",
        targetDocumentId: target.documentId,
        acknowledgedAt: now,
      },
    });
  await ack(users.member.id, annAll);
  await ack(salesUser.id, annSales);
  await ack(users.editor.id, annEng);
  const progress = (user: number, target: Row) =>
    t.strapi.db.query("api::lesson-progress.lesson-progress").create({
      data: { user, targetDocumentId: target.documentId, completedAt: now },
    });
  await progress(users.member.id, lesson);
  await progress(salesUser.id, draftLesson);
  await progress(users.editor.id, lesson);

  const EVENT = "api::event.event";
  const eventA = await create(EVENT, "events", "S:event:a", {
    title: "S:event:a",
    start: "2026-10-05T08:00:00.000Z",
    rsvpEnabled: true,
  });
  const eventB = await create(EVENT, "events", "S:event:b", {
    title: "S:event:b",
    start: "2026-10-06T08:00:00.000Z",
    rsvpEnabled: true,
  });
  const rsvp = (user: number, target: Row, status: string) =>
    t.strapi.db.query("api::event-rsvp.event-rsvp").create({
      data: { user, targetDocumentId: target.documentId, status, respondedAt: now },
    });
  await rsvp(users.member.id, eventA, "yes");
  await rsvp(salesUser.id, eventB, "no");
  await rsvp(users.editor.id, eventA, "maybe");

  await t.requireBuilt<NotifyModule>("src/utils/notify").__fanoutsSettledForTest();
  return {
    labels,
    targets,
    details,
    salesMember: { username: "it-sales-member", password: salesPassword },
  };
}

describe.each(testEngines())("role read snapshot on %s", (engine) => {
  let t: TestStrapi;
  let seeded: Seeded;
  const jwts = new Map<CallerName, Caller>();

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    seeded = await seed(t);
    for (const name of CALLERS) {
      if (name === "anonymous") jwts.set(name, null);
      else if (name === "sales_member") {
        const { username, password } = seeded.salesMember;
        jwts.set(name, { jwt: await t.login(username, password) });
      } else jwts.set(name, name);
    }
  });

  afterAll(async () => {
    await t?.stop();
  });

  const labelOf = (documentId: unknown): string | null =>
    typeof documentId === "string" ? (seeded.labels.get(documentId) ?? null) : null;

  const list = async (caller: Caller, endpoint: Endpoint, query = ""): Promise<Answer> => {
    const separator = query === "" ? "" : "&";
    const res = await t.api<{ data?: Params[] }>(
      caller,
      `${endpoint.path}?pagination[pageSize]=100${separator}${query}`,
    );
    if (res.status !== 200) return res.status;
    return (res.body.data ?? [])
      .map((row) => endpoint.label(row, labelOf))
      .filter((label): label is string => label !== null)
      .sort();
  };

  it("matches the recorded per-role snapshot", async () => {
    const snapshot: Snapshot = {};
    for (const name of CALLERS) {
      const caller = jwts.get(name) ?? null;
      const answers: Record<string, Answer> = {};
      for (const [key, endpoint] of Object.entries(LISTS)) {
        answers[`list ${key}`] = await list(caller, endpoint);
      }
      // The web's comment-section filter: one {targetType, targetDocumentId} pin.
      for (const target of seeded.targets) {
        const pin =
          `filters[targetType][$eq]=${target.targetType}` +
          `&filters[targetDocumentId][$eq]=${target.documentId}`;
        answers[`thread comments ${target.label}`] = await list(caller, LISTS.comments, pin);
        answers[`thread reactions ${target.label}`] = await list(caller, LISTS.reactions, pin);
      }
      for (const [plural, byLabel] of Object.entries(seeded.details)) {
        if (plural === "events") continue;
        for (const [label, documentId] of Object.entries(byLabel)) {
          const res = await t.api(caller, `/api/${plural}/${documentId}`);
          answers[`detail ${plural} ${label}`] = res.status;
        }
      }
      snapshot[name] = answers;
    }
    const lines = Object.entries(snapshot).flatMap(([name, answers]) =>
      Object.entries(answers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, answer]) => `${name} | ${key} | ${JSON.stringify(answer)}`),
    );
    await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(SNAPSHOT);
  }, 240_000);
});
