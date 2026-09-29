/**
 * Digest gate (issue #18, FX13): no owner-domain fallbacks — the link base
 * and the sender come from env only, and a missing one skips the run with an
 * error-level reason (also logged once at boot, FX13 review) instead of
 * mailing someone else's domain. The gate runs before any DB or SMTP access
 * (dark mode invariant).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_UID,
  DEPT,
  KUDOS_UID,
  NOTIFICATION_UID,
  PERMISSION_UID,
  ROLE,
  USER,
  USER_UID,
  createOrgStub,
} from "../test/org-fixtures.test.helper";
import { stubDocumentId, type Row, type StrapiStub } from "../test/strapi-stub.test.helper";
import {
  DIGEST_ANNOUNCEMENT_CAP,
  DIGEST_EXCLUDED_ROLE_TYPES,
  digestsEnabled,
  isDigestRecipient,
  parseEnvFlag,
  reportDigestConfig,
  selectAnnouncements,
  sendDigests,
  type DigestAnnouncement,
} from "./send-digests";

const SMTP = { SMTP_HOST: "mail.acme.io", SMTP_USER: "noreply@acme.io", SMTP_PASS: "app-pass" };
const FULL = {
  ...SMTP,
  PUBLIC_WEB_URL: "https://intranet.acme.io",
  DIGEST_FROM: "Intranet <noreply@acme.io>",
};

describe("digestsEnabled", () => {
  it("sends with complete env and uses PUBLIC_WEB_URL as the link base", () => {
    expect(digestsEnabled(FULL)).toEqual({ kind: "send", baseUrl: "https://intranet.acme.io" });
  });

  it("stays intentionally dark without SMTP or with the kill switch", () => {
    expect(digestsEnabled({}).kind).toBe("skip");
    expect(digestsEnabled({ ...FULL, DIGESTS_DISABLED: "1" })).toEqual({
      kind: "skip",
      reason: "DIGESTS_DISABLED=1",
    });
  });

  it("reads DIGESTS_DISABLED as a boolean, '1' included (B05)", () => {
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(digestsEnabled({ ...FULL, DIGESTS_DISABLED: on }).kind, on).toBe("skip");
    }
    for (const off of ["0", "false", "no", "off", "", " ", "2"]) {
      expect(digestsEnabled({ ...FULL, DIGESTS_DISABLED: off }).kind, off).toBe("send");
    }
    expect(digestsEnabled({ ...FULL, DIGESTS_DISABLED: " true " })).toEqual({
      kind: "skip",
      reason: "DIGESTS_DISABLED=true",
    });
    expect(parseEnvFlag(undefined)).toBe(false);
  });

  it("is misconfigured (not silently defaulted) without PUBLIC_WEB_URL or DIGEST_FROM", () => {
    const noUrl = digestsEnabled({ ...FULL, PUBLIC_WEB_URL: "" });
    expect(noUrl.kind).toBe("misconfigured");
    expect(noUrl.kind !== "send" && noUrl.reason).toContain("PUBLIC_WEB_URL");
    const noFrom = digestsEnabled({ ...FULL, DIGEST_FROM: " " });
    expect(noFrom.kind).toBe("misconfigured");
    expect(noFrom.kind !== "send" && noFrom.reason).toContain("DIGEST_FROM");
    expect(JSON.stringify([noUrl, noFrom])).not.toContain("yurtbay");
  });
});

describe("reportDigestConfig (boot-time echo)", () => {
  it("logs an error only when SMTP is set but the sender or link base is missing", () => {
    const error = vi.fn();
    reportDigestConfig({ error }, FULL);
    reportDigestConfig({ error }, {});
    reportDigestConfig(
      { error },
      { ...SMTP, PUBLIC_WEB_URL: "https://x.acme.io", DIGESTS_DISABLED: "1" },
    );
    expect(error).not.toHaveBeenCalled();

    reportDigestConfig({ error }, { ...SMTP, PUBLIC_WEB_URL: "https://x.acme.io" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("DIGEST_FROM unset");
  });
});

describe("sendDigests gate", () => {
  it("logs an error and returns before any DB access when misconfigured", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, SMTP, { DIGESTS_DISABLED: "0" });
      delete process.env.PUBLIC_WEB_URL;
      process.env.DIGEST_FROM = "Intranet <noreply@acme.io>";
      const error = vi.fn();
      const warn = vi.fn();
      const info = vi.fn();
      const query = vi.fn();
      const plugin = vi.fn();
      await sendDigests({ log: { error, warn, info }, db: { query }, plugin });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("PUBLIC_WEB_URL unset");
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(plugin).not.toHaveBeenCalled();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("dark mode touches neither the database nor SMTP", async () => {
    vi.stubEnv("SMTP_HOST", "");
    const { strapi, send } = digestStub();
    await sendDigests(strapi, NOW);
    expect(strapi.calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[digest] skipped: SMTP env incomplete (SMTP_HOST/USER/PASS)",
    );
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// The orchestrator against the shared stub (FX19, FX48)
// ---------------------------------------------------------------------------

/** Tuesday 2026-09-08, 07:30 in Berlin: the cron's firing. */
const NOW = new Date("2026-09-08T05:30:00.000Z");
/** Monday's run, 24 hours earlier. */
const MONDAY_RUN = "2026-09-07T05:30:00.000Z";
/** A week before: last Monday but one. */
const WEEK_AGO = "2026-08-31T05:30:00.000Z";

const minutesAfter = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

type Mail = { to: string; subject: string; text: string; html: string };

interface DigestFixture {
  /** Per-user overrides of the org fixture's digest fields. */
  users?: Record<number, Record<string, unknown>>;
  announcements?: Row[];
  notifications?: Row[];
  kudos?: Row[];
  /** Makes the email service throw for these addresses. */
  failFor?: string[];
}

function digestStub(fixture: DigestFixture = {}) {
  const send = vi.fn(async (mail: Mail) => {
    if (fixture.failFor?.includes(mail.to)) throw new Error("SMTP 451 try again later");
  });
  const strapi = createOrgStub({
    plugins: { email: { email: { send } } },
    extraTables: {
      [ANNOUNCEMENT_UID]: fixture.announcements ?? [],
      [NOTIFICATION_UID]: fixture.notifications ?? [],
      [KUDOS_UID]: fixture.kudos ?? [],
    },
  });
  for (const user of strapi.tables[USER_UID]) {
    Object.assign(user, fixture.users?.[user.id] ?? {});
  }
  return { strapi, send, mails: () => send.mock.calls.map(([mail]) => mail) };
}

let announcementId = 500;

/** A published announcement row (the digest reads published rows only). */
function news(title: string, publishedAt: string, data: Record<string, unknown> = {}): Row {
  announcementId += 1;
  return {
    id: announcementId,
    documentId: stubDocumentId(announcementId),
    title,
    audience: "all",
    publishedAt,
    author: { id: USER.carol },
    department: null,
    team: null,
    audienceRoles: [],
    ...data,
  };
}

const optIn = (extra: Record<string, unknown> = {}) => ({
  digestAnnouncements: true,
  digestFrequency: "daily",
  lastDigestAt: MONDAY_RUN,
  ...extra,
});

const mailTo = (mails: Mail[], username: string) =>
  mails.find((mail) => mail.to === `${username}@sinnlos.local`);

const lastDigestAt = (strapi: StrapiStub, id: number) =>
  strapi.tables[USER_UID].find((user) => user.id === id)?.lastDigestAt;

describe("sendDigests orchestrator", () => {
  beforeEach(() => {
    vi.stubEnv("SMTP_HOST", FULL.SMTP_HOST);
    vi.stubEnv("SMTP_USER", FULL.SMTP_USER);
    vi.stubEnv("SMTP_PASS", FULL.SMTP_PASS);
    vi.stubEnv("PUBLIC_WEB_URL", FULL.PUBLIC_WEB_URL);
    vi.stubEnv("DIGEST_FROM", FULL.DIGEST_FROM);
    vi.stubEnv("DIGESTS_DISABLED", "0");
    vi.stubEnv("APP_TIME_ZONE", "Europe/Berlin");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("filters before it caps: 30 announcements, only the OLDEST visible, still arrives", async () => {
    const oldest = news("For Engineering", minutesAfter(MONDAY_RUN, 1), {
      department: { id: DEPT.engineering },
    });
    const sales = Array.from({ length: 29 }, (_, i) =>
      news(`Sales ${i + 1}`, minutesAfter(MONDAY_RUN, 10 + i), { department: { id: DEPT.sales } }),
    );
    const { strapi, mails } = digestStub({
      users: { [USER.alice]: optIn(), [USER.bob]: optIn() },
      announcements: [oldest, ...sales],
    });
    await sendDigests(strapi, NOW);

    const alice = mailTo(mails(), "alice");
    expect(alice?.text).toContain("• For Engineering — Carol");
    expect(alice?.text).not.toContain("Sales");
    // bob (Sales) sees 29: the 25 newest, then "+4 more".
    const bob = mailTo(mails(), "bob");
    expect(bob?.subject).toBe("Sinnlos intranet: 29 updates for you");
    expect(bob?.text).toContain("• Sales 29 — Carol");
    expect(bob?.text).not.toContain("• Sales 4 —");
    expect(bob?.text).toContain("• Sales 5 — Carol\n• +4 more");
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[digest] run complete: sent=2 empty=0 skipped=0 failed=0 of 2 candidate(s)",
    );
  });

  it("leaves out announcements expired by the run's now, for every recipient (DA02)", async () => {
    const { strapi, mails } = digestStub({
      users: { [USER.alice]: optIn(), [USER.carol]: optIn() },
      announcements: [
        news("Ended at dawn", minutesAfter(MONDAY_RUN, 5), {
          expiresAt: minutesAfter(NOW.toISOString(), -60),
        }),
        news("Ends right now", minutesAfter(MONDAY_RUN, 6), { expiresAt: NOW.toISOString() }),
        news("Ends tonight", minutesAfter(MONDAY_RUN, 7), {
          expiresAt: minutesAfter(NOW.toISOString(), 12 * 60),
        }),
        news("Never ends", minutesAfter(MONDAY_RUN, 8), { expiresAt: null }),
      ],
    });
    await sendDigests(strapi, NOW);
    for (const user of ["alice", "carol"]) {
      const text = mailTo(mails(), user)?.text ?? "";
      expect(text, user).toContain("• Ends tonight");
      expect(text, user).toContain("• Never ends");
      expect(text, user).not.toContain("Ended at dawn");
      expect(text, user).not.toContain("Ends right now");
    }
  });

  it("reads users, scopes, grants, announcements and anchors once per run", async () => {
    const users = Object.fromEntries(
      [USER.alice, USER.bob, USER.carol, USER.dave, USER.anna].map((id) => [id, optIn()]),
    );
    const { strapi } = digestStub({
      users,
      announcements: [news("All hands", minutesAfter(MONDAY_RUN, 5))],
    });
    await sendDigests(strapi, NOW);

    const reads = strapi.calls.map((call) => `${call.method} ${call.uid}`);
    const count = (entry: string) => reads.filter((read) => read === entry).length;
    expect(count(`findMany ${USER_UID}`)).toBe(2); // candidates + scopes
    expect(count("findMany api::team.team")).toBe(1);
    expect(count(`findMany ${PERMISSION_UID}`)).toBe(1);
    expect(count(`findMany ${ANNOUNCEMENT_UID}`)).toBe(1);
    expect(count(`findMany ${NOTIFICATION_UID}`)).toBe(1);
    expect(count(`update ${USER_UID}`)).toBe(5);
    // Nothing per user but the lastDigestAt update (no mentions/kudos opted in).
    expect(reads).toHaveLength(6 + 5);
  });

  it("guest, blocked, member, admin: only active readers, strictly their audience", async () => {
    const { strapi, mails } = digestStub({
      users: {
        [USER.gina]: optIn({ digestMentions: true, digestKudos: true }),
        [USER.bert]: optIn(),
        [USER.alice]: optIn(),
        [USER.anna]: optIn(),
      },
      announcements: [
        news("Engineering only", minutesAfter(MONDAY_RUN, 1), {
          department: { id: DEPT.engineering },
        }),
        news("Everyone", minutesAfter(MONDAY_RUN, 2)),
      ],
    });
    await sendDigests(strapi, NOW);

    expect(mailTo(mails(), "gina")).toBeUndefined();
    expect(mailTo(mails(), "bert")).toBeUndefined();
    expect(mailTo(mails(), "alice")?.text).toContain("Engineering only");
    // anna (admin_role, Sales): no bypass in the digest (owner default).
    expect(mailTo(mails(), "anna")?.text).not.toContain("Engineering only");
    expect(mailTo(mails(), "anna")?.text).toContain("Everyone");
    expect(lastDigestAt(strapi, USER.gina)).toBe(MONDAY_RUN);
    // bert is no candidate at all (blocked), gina is skipped.
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[digest] run complete: sent=2 empty=0 skipped=1 failed=0 of 3 candidate(s)",
    );
  });

  it("a guest is skipped even if up_permissions granted it announcement.find", async () => {
    const { strapi, mails } = digestStub({
      users: { [USER.gina]: optIn() },
      announcements: [news("Everyone", minutesAfter(MONDAY_RUN, 2))],
    });
    strapi.tables[PERMISSION_UID].push({
      id: 999,
      action: "api::announcement.announcement.find",
      role: { id: ROLE.guest },
    });
    await sendDigests(strapi, NOW);
    expect(mails()).toEqual([]);
  });

  it("the kudos section needs kudos.find", async () => {
    const kudos = [
      {
        id: 1,
        message: "Thanks!",
        value: "teamwork",
        to: { id: USER.alice },
        from: { id: USER.bob },
        createdAt: minutesAfter(MONDAY_RUN, 3),
      },
    ];
    const withGrant = digestStub({
      users: { [USER.alice]: optIn({ digestAnnouncements: false, digestKudos: true }) },
      kudos,
    });
    await sendDigests(withGrant.strapi, NOW);
    expect(mailTo(withGrant.mails(), "alice")?.text).toContain('"Thanks!" from Bob');

    const withoutGrant = digestStub({
      users: { [USER.alice]: optIn({ digestAnnouncements: false, digestKudos: true }) },
      kudos,
    });
    withoutGrant.strapi.tables[PERMISSION_UID] = withoutGrant.strapi.tables[PERMISSION_UID].filter(
      (p) => p.action !== "api::kudos.kudos.find",
    );
    await sendDigests(withoutGrant.strapi, NOW);
    expect(withoutGrant.mails()).toEqual([]);
    expect(withoutGrant.strapi.calls.some((call) => call.uid === KUDOS_UID)).toBe(false);
  });

  it("a republished announcement appears once: not again after the fan-out told the user", async () => {
    // Published last week (the fan-out notified alice then), republished
    // yesterday after a typo fix: new row, new publishedAt, same documentId.
    const typoFix = news("Holiday rota (fixed)", minutesAfter(MONDAY_RUN, 30));
    // First published inside the window and republished inside it: new.
    const fresh = news("Canteen menu", minutesAfter(MONDAY_RUN, 40));
    const anchored = (documentId: unknown, recipient: number, createdAt: string): Row => ({
      id: Number(`9${recipient}${String(documentId).slice(-2)}`),
      type: "announcement",
      title: "New announcement: …",
      sourceType: "announcement",
      sourceDocumentId: documentId,
      recipient: { id: recipient },
      createdAt,
    });
    const { strapi, mails } = digestStub({
      users: { [USER.alice]: optIn(), [USER.bob]: optIn() },
      announcements: [typoFix, fresh],
      notifications: [
        anchored(typoFix.documentId, USER.alice, WEEK_AGO),
        anchored(fresh.documentId, USER.alice, minutesAfter(MONDAY_RUN, 10)),
        anchored(fresh.documentId, USER.bob, minutesAfter(MONDAY_RUN, 10)),
      ],
    });
    await sendDigests(strapi, NOW);

    const alice = mailTo(mails(), "alice")?.text ?? "";
    expect(alice).not.toContain("Holiday rota");
    expect(alice.match(/Canteen menu/g)).toHaveLength(1);
    // bob never got the first notification (joined later): it is news to him.
    expect(mailTo(mails(), "bob")?.text).toContain("Holiday rota (fixed)");
  });

  it("the author's own republish is not news to them; a user new to the audience gets it once", async () => {
    // Published Monday before the run for Engineering (alice notified), then
    // opened to everyone and republished in the afternoon (bob notified).
    // carol, the author, is never notified by the fan-out.
    const early = minutesAfter(MONDAY_RUN, -90);
    const afternoon = minutesAfter(MONDAY_RUN, 8 * 60);
    const reorg = news("Reorg (update)", afternoon);
    // carol's own announcement first published inside the window: listed.
    const own = news("Carol's new one", minutesAfter(MONDAY_RUN, 9 * 60));
    const other = news("Canteen menu", minutesAfter(MONDAY_RUN, 10 * 60), {
      author: { id: USER.dave },
    });
    const anchored = (documentId: unknown, recipient: number, createdAt: string): Row => ({
      id: Number(`8${recipient}${String(documentId).slice(-2)}`),
      type: "announcement",
      title: "New announcement: …",
      sourceType: "announcement",
      sourceDocumentId: documentId,
      recipient: { id: recipient },
      createdAt,
    });
    const users = { [USER.alice]: optIn(), [USER.bob]: optIn(), [USER.carol]: optIn() };
    const notifications = [
      anchored(reorg.documentId, USER.alice, early),
      anchored(reorg.documentId, USER.bob, afternoon),
      anchored(own.documentId, USER.alice, minutesAfter(MONDAY_RUN, 9 * 60)),
    ];
    const { strapi, mails } = digestStub({
      users,
      announcements: [reorg, own, other],
      notifications,
    });
    await sendDigests(strapi, NOW);

    const carol = mailTo(mails(), "carol")?.text ?? "";
    expect(carol).not.toContain("Reorg (update)");
    expect(carol).toContain("Carol's new one");
    expect(carol).toContain("Canteen menu");
    expect(mailTo(mails(), "bob")?.text).toContain("Reorg (update)");
    expect(mailTo(mails(), "alice")?.text).not.toContain("Reorg (update)");

    // The next republish (Tuesday) is not news to bob either.
    const wednesday = new Date("2026-09-09T05:30:00.000Z");
    const again = news("Reorg (final)", minutesAfter(NOW.toISOString(), 60), {
      documentId: reorg.documentId,
    });
    const next = digestStub({
      users: {
        [USER.bob]: optIn({ lastDigestAt: NOW.toISOString() }),
        [USER.carol]: optIn({ lastDigestAt: NOW.toISOString() }),
      },
      announcements: [again, news("Parking", minutesAfter(NOW.toISOString(), 90))],
      notifications,
    });
    await sendDigests(next.strapi, wednesday);
    expect(mailTo(next.mails(), "bob")?.text).not.toContain("Reorg");
    expect(mailTo(next.mails(), "carol")?.text).not.toContain("Reorg");
  });

  it("lastDigestAt: set to the window's now after a send, kept for empty and failed digests", async () => {
    const { strapi, mails } = digestStub({
      users: {
        [USER.alice]: optIn(),
        [USER.bob]: optIn({ digestAnnouncements: false, digestMentions: true }),
        [USER.dave]: optIn(),
      },
      announcements: [news("Everyone", minutesAfter(MONDAY_RUN, 2))],
      failFor: ["dave@sinnlos.local"],
    });
    await sendDigests(strapi, NOW);
    expect(mails().map((mail) => mail.to)).toEqual(["alice@sinnlos.local", "dave@sinnlos.local"]);
    expect(lastDigestAt(strapi, USER.alice)).toBe(NOW.toISOString());
    expect(lastDigestAt(strapi, USER.bob)).toBe(MONDAY_RUN); // empty
    expect(lastDigestAt(strapi, USER.dave)).toBe(MONDAY_RUN); // failed
    expect(strapi.log.warn).toHaveBeenCalledWith(
      `[digest] user ${USER.dave} failed: SMTP 451 try again later`,
    );
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[digest] run complete: sent=1 empty=1 skipped=0 failed=1 of 3 candidate(s)",
    );
  });

  it("an announcement read failure fails the users who want announcements, not the others", async () => {
    const { strapi, mails } = digestStub({
      users: {
        [USER.alice]: optIn(),
        [USER.bob]: optIn({ digestAnnouncements: false, digestMentions: true }),
      },
      notifications: [
        {
          id: 1,
          type: "comment",
          title: 'Alice commented on "Plan"',
          recipient: { id: USER.bob },
          createdAt: minutesAfter(MONDAY_RUN, 3),
        },
      ],
    });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      if (uid === ANNOUNCEMENT_UID) throw new Error("db down");
      return query(uid);
    };
    await sendDigests(strapi, NOW);
    expect(mails().map((mail) => mail.to)).toEqual(["bob@sinnlos.local"]);
    expect(lastDigestAt(strapi, USER.alice)).toBe(MONDAY_RUN);
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[digest] could not load the announcements: db down",
    );
  });

  it("a recipient read failure fails every due user and still ends the run with its summary", async () => {
    const { strapi, send } = digestStub({
      users: { [USER.alice]: optIn(), [USER.bob]: optIn({ lastDigestAt: NOW.toISOString() }) },
      announcements: [news("All hands", minutesAfter(MONDAY_RUN, 5))],
    });
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      if (uid === PERMISSION_UID) throw new Error("db down");
      return query(uid);
    };
    await expect(sendDigests(strapi, NOW)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(lastDigestAt(strapi, USER.alice)).toBe(MONDAY_RUN);
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[digest] could not load the recipients: db down",
    );
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[digest] run complete: sent=0 empty=0 skipped=1 failed=1 of 2 candidate(s)",
    );
  });

  it("a weekly digest that failed on Monday is sent on Tuesday, then not again that week", async () => {
    const saturday = news("Weekend on-call", "2026-09-05T09:00:00.000Z");
    const { strapi, send, mails } = digestStub({
      users: { [USER.alice]: optIn({ digestFrequency: "weekly", lastDigestAt: WEEK_AGO }) },
      announcements: [saturday],
      failFor: ["alice@sinnlos.local"],
    });

    await sendDigests(strapi, new Date(MONDAY_RUN));
    expect(send).toHaveBeenCalledTimes(1);
    expect(lastDigestAt(strapi, USER.alice)).toBe(WEEK_AGO);

    send.mockImplementation(async () => undefined);
    await sendDigests(strapi, NOW);
    expect(mailTo(mails(), "alice")?.text).toContain("Weekend on-call");
    expect(lastDigestAt(strapi, USER.alice)).toBe(NOW.toISOString());

    const wednesday = new Date("2026-09-09T05:30:00.000Z");
    await sendDigests(strapi, wednesday);
    expect(send).toHaveBeenCalledTimes(2);
    expect(strapi.log.info).toHaveBeenLastCalledWith(
      "[digest] run complete: sent=0 empty=0 skipped=1 failed=0 of 1 candidate(s)",
    );
  });

  it("no due user: one query, nothing else", async () => {
    const { strapi } = digestStub({
      users: { [USER.alice]: optIn({ lastDigestAt: NOW.toISOString() }) },
    });
    await sendDigests(strapi, NOW);
    expect(strapi.calls.map((call) => `${call.method} ${call.uid}`)).toEqual([
      `findMany ${USER_UID}`,
    ]);
  });
});

describe("selectAnnouncements", () => {
  const scope = {
    userId: USER.alice,
    roleId: ROLE.member,
    roleType: "member",
    departmentId: DEPT.engineering,
    teamIds: [],
    ledTeamIds: [],
  };
  const since = new Date(MONDAY_RUN);

  it("drops rows before the user's window and duplicates of a documentId", () => {
    const early = news("Before", minutesAfter(MONDAY_RUN, -1));
    const kept = news("Kept", minutesAfter(MONDAY_RUN, 2));
    const twin = { ...kept, id: kept.id + 1000, title: "Older twin" } as Row;
    const rows = [kept, twin, early] as unknown as DigestAnnouncement[];
    expect(selectAnnouncements(rows, { since, scope, notifiedAt: new Map() })).toEqual({
      items: [{ title: "Kept", author: null }],
      more: 0,
    });
  });

  it("caps at the given size and counts the rest", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      news(`N${i}`, minutesAfter(MONDAY_RUN, 10 - i)),
    ) as unknown as DigestAnnouncement[];
    const { items, more } = selectAnnouncements(rows, {
      since,
      scope,
      notifiedAt: new Map(),
      cap: 2,
    });
    expect(items.map((item) => item.title)).toEqual(["N0", "N1"]);
    expect(more).toBe(3);
    expect(DIGEST_ANNOUNCEMENT_CAP).toBe(25);
  });

  it("the author's own announcement: dropped once any anchor predates the window", () => {
    const own = news("Own", minutesAfter(MONDAY_RUN, 5), { author: { id: USER.alice } });
    const foreign = news("Foreign", minutesAfter(MONDAY_RUN, 6));
    const rows = [foreign, own] as unknown as DigestAnnouncement[];
    const before = Date.parse(MONDAY_RUN) - 60_000;
    const inside = Date.parse(MONDAY_RUN) + 60_000;
    const titles = (firstNotifiedAt?: Map<string, number>) =>
      selectAnnouncements(rows, { since, scope, notifiedAt: new Map(), firstNotifiedAt }).items.map(
        (item) => item.title,
      );
    const first = (at: number) =>
      new Map([
        [String(own.documentId), at],
        [String(foreign.documentId), at],
      ]);
    expect(titles(first(before))).toEqual(["Foreign"]);
    expect(titles(first(inside))).toEqual(["Foreign", "Own"]);
    expect(titles()).toEqual(["Foreign", "Own"]);
  });

  it("isDigestRecipient: no scope, a guest, or a role without the grant is out", () => {
    const readers = new Set([ROLE.member]);
    expect(isDigestRecipient(scope, readers)).toBe(true);
    expect(isDigestRecipient(undefined, readers)).toBe(false);
    expect(isDigestRecipient({ ...scope, roleType: "guest" }, readers)).toBe(false);
    expect(isDigestRecipient({ ...scope, roleId: ROLE.guest }, readers)).toBe(false);
    expect(DIGEST_EXCLUDED_ROLE_TYPES).toEqual(["guest"]);
  });
});
