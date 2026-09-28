/**
 * GET/PUT /api/me allowlist serializer (FX02).
 *
 * The controller reads through strapi.db.query, which returns EVERY column —
 * schema-`private` ones included — and answers via ctx.send, which skips the
 * content-api output sanitizer. The stub below models exactly that: the raw
 * rows carry the password hash, reset/confirmation tokens, birthday and
 * lastDigestAt, and a populate WITHOUT `select` hands the full manager row
 * back. The assertions therefore prove both layers: the explicit manager
 * select (private columns never loaded) and the output allowlist (nothing
 * outside the named keys ever leaves).
 *
 * Plain-object stubs only — no Strapi runtime, no DB (policies/*.test.ts
 * pattern; the global `strapi` is swapped per test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SENSITIVE_USER_FIELDS } from "../../../utils/sanitize-user-contact";
import profile, {
  DIGEST_FIELDS,
  DIGEST_IGNORED_ROLE_TYPES,
  MANAGER_CONTACT_FIELDS,
  MANAGER_SUMMARY_FIELDS,
  PROFILE_LOCALES,
  PROFILE_TEXT_FIELDS,
  PROFILE_TEXT_MAX,
  SELF_PROFILE_FIELDS,
  normalizeProfileText,
  toManagerSummary,
  toSelfProfile,
  type ProfileContext,
} from "./profile";

type Row = Record<string, unknown>;

/** Columns that must never leave /api/me for ANY user. */
const SECRET_KEYS = ["password", "resetPasswordToken", "confirmationToken"];
/** The Entra identity and role-ownership columns (D-ENTRA-01): never in /api/me. */
const ENTRA_COLUMNS = [
  "microsoftOid",
  "entraTenantId",
  "roleSource",
  "entraAppliedRole",
  "entraManagerOid",
];
/** Columns that are the caller's own business only. */
const FOREIGN_PRIVATE_KEYS = [...SECRET_KEYS, "birthday", "birthdayVisible", "lastDigestAt"];

const MANAGER_ROW: Row = {
  id: 2,
  documentId: "mgr-doc",
  username: "alex.morgan",
  email: "alex@example.com",
  provider: "local",
  password: "$2a$10$managerhash",
  resetPasswordToken: "manager-reset-token",
  confirmationToken: "manager-confirm-token",
  confirmed: true,
  blocked: false,
  microsoftOid: "oid-manager",
  displayName: "Alex Morgan",
  jobTitle: "CTO",
  locale: "de",
  phone: "+49 30 1234",
  officeLocation: "Berlin HQ",
  hireDate: "2012-04-01",
  birthday: "1979-06-15",
  birthdayVisible: false,
  digestAnnouncements: true,
  digestMentions: false,
  digestKudos: false,
  digestFrequency: "daily",
  lastDigestAt: "2026-09-20T07:30:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

function selfRow(): Row {
  return {
    id: 1,
    documentId: "self-doc",
    username: "sam.chen",
    email: "sam@example.com",
    provider: "local",
    password: "$2a$10$ownhash",
    resetPasswordToken: "own-reset-token",
    confirmationToken: "own-confirm-token",
    confirmed: true,
    blocked: false,
    microsoftOid: "oid-self",
    displayName: "Sam Chen",
    jobTitle: "Engineer",
    locale: "en",
    phone: "+49 30 5678",
    officeLocation: "Remote",
    hireDate: "2020-02-01",
    birthday: "1990-02-03",
    birthdayVisible: true,
    digestAnnouncements: true,
    digestMentions: true,
    digestKudos: false,
    digestFrequency: "weekly",
    lastDigestAt: "2026-09-21T07:30:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    role: {
      id: 5,
      documentId: "role-doc",
      name: "Member",
      description: "Regular employee",
      type: "member",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    department: {
      id: 10,
      documentId: "dept-doc",
      name: "Engineering",
      slug: "engineering",
      description: "Long rich text",
      color: "#6366f1",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    avatar: {
      id: 77,
      documentId: "file-doc",
      name: "sam.png",
      alternativeText: null,
      width: 256,
      height: 256,
      formats: { thumbnail: { url: "/uploads/thumbnail_sam.png" } },
      hash: "sam_abc123",
      url: "/uploads/sam.png",
      mime: "image/png",
      provider: "local",
      provider_metadata: { uploadedBy: 1 },
    },
  };
}

interface FindOneArgs {
  where: { id: number };
  populate?: Record<string, unknown>;
}
interface UpdateArgs {
  where: { id: number };
  data: Row;
}

/**
 * db.query stub that behaves like @strapi/database for this controller:
 * a relation populate of `true` returns the FULL target row (private columns
 * included); `{ select: [...] }` returns only those columns.
 */
function stubStrapi(opts: { manager?: Row | null; self?: Row } = {}) {
  const row = { ...selfRow(), ...opts.self };
  const manager = opts.manager === undefined ? MANAGER_ROW : opts.manager;
  const findOneCalls: FindOneArgs[] = [];
  const updateCalls: UpdateArgs[] = [];

  const populateRelation = (value: unknown, target: Row | null): Row | null => {
    if (!target) return null;
    if (value === true) return { ...target };
    const select = (value as { select?: unknown }).select;
    if (!Array.isArray(select)) return { ...target };
    const out: Row = {};
    for (const key of select as string[]) if (key in target) out[key] = target[key];
    return out;
  };

  const strapi = {
    db: {
      query: (uid: string) => {
        expect(uid).toBe("plugin::users-permissions.user");
        return {
          findOne: async (args: FindOneArgs) => {
            findOneCalls.push(args);
            if (args.where.id !== row.id) return null;
            const { role, department, avatar, ...scalars } = row;
            const result: Row = { ...scalars };
            const populate = args.populate ?? {};
            if (populate.role) result.role = role;
            if (populate.department) result.department = department;
            if (populate.avatar) result.avatar = avatar;
            if (populate.manager) result.manager = populateRelation(populate.manager, manager);
            return result;
          },
          update: async (args: UpdateArgs) => {
            updateCalls.push(args);
            Object.assign(row, args.data);
            return row;
          },
        };
      },
    },
  };
  return { strapi, findOneCalls, updateCalls };
}

interface CtxResult {
  ctx: ProfileContext;
  sent: () => Row | undefined;
}

function makeCtx(user: ProfileContext["state"]["user"], body?: unknown): CtxResult {
  let sent: Row | undefined;
  const ctx: ProfileContext = {
    state: { user },
    request: { body },
    send: (payload) => {
      sent = (payload as { data: Row }).data;
      return payload;
    },
    unauthorized: () => "401",
    notFound: () => "404",
    badRequest: (message) => `400 ${message}`,
  };
  return { ctx, sent: () => sent };
}

const caller = (roleType?: string | null) => ({
  id: 1,
  role: roleType === undefined ? undefined : { type: roleType },
});

const RELATION_KEYS = ["role", "department", "avatar", "manager"];
const ALLOWED_TOP_LEVEL = new Set<string>([
  ...SELF_PROFILE_FIELDS,
  ...RELATION_KEYS,
  // Computed (D-ENTRA-01): which fields the form must not offer.
  "entraManagedFields",
]);

describe("GET /api/me (FX02 allowlist)", () => {
  let stub: ReturnType<typeof stubStrapi>;

  beforeEach(() => {
    stub = stubStrapi();
    vi.stubGlobal("strapi", stub.strapi);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers only allowlisted top-level keys and never the caller's secrets", async () => {
    const { ctx, sent } = makeCtx(caller("member"));
    await profile.me(ctx);
    const data = sent()!;
    for (const key of Object.keys(data)) expect(ALLOWED_TOP_LEVEL.has(key)).toBe(true);
    for (const key of SECRET_KEYS) expect(data).not.toHaveProperty(key);
    // Internal / not-needed columns are dropped too.
    expect(data).not.toHaveProperty("microsoftOid");
    expect(data).not.toHaveProperty("publishedAt");
  });

  it("returns the caller's OWN private fields (birthday, digest state)", async () => {
    const { ctx, sent } = makeCtx(caller("member"));
    await profile.me(ctx);
    expect(sent()).toMatchObject({
      id: 1,
      username: "sam.chen",
      email: "sam@example.com",
      displayName: "Sam Chen",
      jobTitle: "Engineer",
      phone: "+49 30 5678",
      officeLocation: "Remote",
      locale: "en",
      birthday: "1990-02-03",
      birthdayVisible: true,
      digestAnnouncements: true,
      digestMentions: true,
      digestKudos: false,
      digestFrequency: "weekly",
      lastDigestAt: "2026-09-21T07:30:00.000Z",
    });
  });

  it("reduces role/department/avatar to summaries (web shape kept)", async () => {
    const { ctx, sent } = makeCtx(caller("member"));
    await profile.me(ctx);
    const data = sent()!;
    expect(data.role).toEqual({ id: 5, documentId: "role-doc", name: "Member", type: "member" });
    expect(data.department).toEqual({
      id: 10,
      documentId: "dept-doc",
      name: "Engineering",
      slug: "engineering",
    });
    // avatarThumbUrl() reads formats/url.
    expect(data.avatar).toMatchObject({
      url: "/uploads/sam.png",
      formats: { thumbnail: { url: "/uploads/thumbnail_sam.png" } },
    });
    expect(data.avatar).not.toHaveProperty("provider_metadata");
    expect(data.avatar).not.toHaveProperty("hash");
  });

  it.each([
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
    "guest",
    "authenticated",
    null,
  ])("never loads or returns the manager's private columns (caller role %s)", async (roleType) => {
    const { ctx, sent } = makeCtx(caller(roleType));
    await profile.me(ctx);

    // The populate itself carries an explicit select without private columns.
    const populate = stub.findOneCalls[0].populate!;
    const select = (populate.manager as { select: string[] }).select;
    expect(Array.isArray(select)).toBe(true);
    for (const key of [...FOREIGN_PRIVATE_KEYS, "hireDate", "microsoftOid"]) {
      expect(select).not.toContain(key);
    }

    const manager = sent()!.manager as Row;
    for (const key of FOREIGN_PRIVATE_KEYS) expect(manager).not.toHaveProperty(key);
    expect(manager).toMatchObject({
      id: 2,
      documentId: "mgr-doc",
      username: "alex.morgan",
      displayName: "Alex Morgan",
      jobTitle: "CTO",
    });
  });

  it.each(["admin_role", "editor", "department_head", "team_lead", "member"])(
    "privileged caller (%s) keeps the manager's contact fields",
    async (roleType) => {
      const { ctx, sent } = makeCtx(caller(roleType));
      await profile.me(ctx);
      expect(sent()!.manager).toEqual({
        id: 2,
        documentId: "mgr-doc",
        username: "alex.morgan",
        displayName: "Alex Morgan",
        jobTitle: "CTO",
        email: "alex@example.com",
        phone: "+49 30 1234",
        officeLocation: "Berlin HQ",
      });
    },
  );

  it.each(["guest", "authenticated", "public", "unknown-role", null, undefined])(
    "non-privileged caller (%s) gets no manager contact fields — not even loaded",
    async (roleType) => {
      const { ctx, sent } = makeCtx(caller(roleType));
      await profile.me(ctx);
      const select = (stub.findOneCalls[0].populate!.manager as { select: string[] }).select;
      for (const key of SENSITIVE_USER_FIELDS) expect(select).not.toContain(key);
      const manager = sent()!.manager as Row;
      for (const key of SENSITIVE_USER_FIELDS) expect(manager).not.toHaveProperty(key);
      expect(Object.keys(manager).sort()).toEqual([...MANAGER_SUMMARY_FIELDS].sort());
    },
  );

  it("answers manager: null when the caller has no manager", async () => {
    stub = stubStrapi({ manager: null });
    vi.stubGlobal("strapi", stub.strapi);
    const { ctx, sent } = makeCtx(caller("member"));
    await profile.me(ctx);
    expect(sent()!.manager).toBeNull();
  });

  it("always reads the caller's own id", async () => {
    const { ctx } = makeCtx(caller("member"));
    await profile.me(ctx);
    expect(stub.findOneCalls).toHaveLength(1);
    expect(stub.findOneCalls[0].where).toEqual({ id: 1 });
  });

  it("401 without a user, 404 when the row is gone", async () => {
    const anon = makeCtx(null);
    await expect(profile.me(anon.ctx)).resolves.toBe("401");
    const ghost = makeCtx({ id: 999, role: { type: "member" } });
    await expect(profile.me(ghost.ctx)).resolves.toBe("404");
    expect(ghost.sent()).toBeUndefined();
  });
});

describe("PUT /api/me (FX02 allowlist)", () => {
  let stub: ReturnType<typeof stubStrapi>;

  beforeEach(() => {
    stub = stubStrapi();
    vi.stubGlobal("strapi", stub.strapi);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers through the same allowlist as GET", async () => {
    const { ctx, sent } = makeCtx(caller("guest"), { data: { displayName: "Sam C." } });
    await profile.updateMe(ctx);
    const data = sent()!;
    expect(data.displayName).toBe("Sam C.");
    for (const key of Object.keys(data)) expect(ALLOWED_TOP_LEVEL.has(key)).toBe(true);
    for (const key of SECRET_KEYS) expect(data).not.toHaveProperty(key);
    const manager = data.manager as Row;
    for (const key of [...FOREIGN_PRIVATE_KEYS, ...SENSITIVE_USER_FIELDS]) {
      expect(manager).not.toHaveProperty(key);
    }
  });

  it("writes only editable fields to the caller's own row", async () => {
    const { ctx } = makeCtx(caller("member"), {
      data: {
        id: 2,
        displayName: "Sam C.",
        role: 1,
        email: "evil@example.com",
        password: "x",
        manager: 3,
        lastDigestAt: "2000-01-01T00:00:00.000Z",
      },
    });
    await profile.updateMe(ctx);
    expect(stub.updateCalls).toHaveLength(1);
    expect(stub.updateCalls[0]).toEqual({ where: { id: 1 }, data: { displayName: "Sam C." } });
  });

  it("lastDigestAt is readable but never writable", async () => {
    const { ctx } = makeCtx(caller("member"), { lastDigestAt: "2000-01-01T00:00:00.000Z" });
    await expect(profile.updateMe(ctx)).resolves.toBe("400 No editable fields provided");
    expect(stub.updateCalls).toHaveLength(0);
  });

  it("keeps the existing birthday / digest validation", async () => {
    const bad = makeCtx(caller("member"), { data: { birthday: "2026-02-31" } });
    await expect(profile.updateMe(bad.ctx)).resolves.toBe(
      "400 birthday must be a valid calendar date",
    );
    const freq = makeCtx(caller("member"), { data: { digestFrequency: "hourly" } });
    await expect(profile.updateMe(freq.ctx)).resolves.toBe(
      "400 digestFrequency must be daily or weekly",
    );
    const ok = makeCtx(caller("member"), {
      data: { birthday: "", birthdayVisible: "on", digestKudos: "true", digestMentions: "no" },
    });
    await profile.updateMe(ok.ctx);
    expect(stub.updateCalls[stub.updateCalls.length - 1].data).toEqual({
      birthday: null,
      birthdayVisible: true,
      digestKudos: true,
      digestMentions: false,
    });
  });

  it("400 for a missing or non-object body instead of throwing", async () => {
    await expect(profile.updateMe(makeCtx(caller("member")).ctx)).resolves.toBe(
      "400 No editable fields provided",
    );
    await expect(profile.updateMe(makeCtx(caller("member"), "displayName=x").ctx)).resolves.toBe(
      "400 No editable fields provided",
    );
  });
});

describe("PUT /api/me digest opt-ins and guests (FX19)", () => {
  let stub: ReturnType<typeof stubStrapi>;

  beforeEach(() => {
    stub = stubStrapi();
    vi.stubGlobal("strapi", stub.strapi);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const optIns = {
    digestAnnouncements: "on",
    digestMentions: true,
    digestKudos: "true",
    digestFrequency: "daily",
  };

  it("ignores a guest's digest keys and writes the rest", async () => {
    const { ctx } = makeCtx(caller("guest"), { data: { displayName: "Gina", ...optIns } });
    await profile.updateMe(ctx);
    expect(stub.updateCalls).toEqual([{ where: { id: 1 }, data: { displayName: "Gina" } }]);
  });

  it("digest keys alone are nothing editable for a guest (400, no write)", async () => {
    const { ctx } = makeCtx(caller("guest"), { data: optIns });
    await expect(profile.updateMe(ctx)).resolves.toBe("400 No editable fields provided");
    expect(stub.updateCalls).toHaveLength(0);
    // Even an invalid frequency is not looked at: the key is dropped first.
    const bad = makeCtx(caller("guest"), {
      data: { displayName: "Gina", digestFrequency: "hourly" },
    });
    await profile.updateMe(bad.ctx);
    expect(stub.updateCalls[0].data).toEqual({ displayName: "Gina" });
  });

  it("every other role, and a caller without a role, keeps the opt-ins", async () => {
    for (const roleType of ["member", "editor", "admin_role", "authenticated", null, undefined]) {
      stub.updateCalls.length = 0;
      await profile.updateMe(makeCtx(caller(roleType), { data: optIns }).ctx);
      expect(stub.updateCalls[0].data, String(roleType)).toEqual({
        digestAnnouncements: true,
        digestMentions: true,
        digestKudos: true,
        digestFrequency: "daily",
      });
    }
  });

  it("DIGEST_FIELDS are editable fields and exactly the digest opt-ins", () => {
    expect([...DIGEST_FIELDS]).toEqual([
      "digestAnnouncements",
      "digestMentions",
      "digestKudos",
      "digestFrequency",
    ]);
    expect(DIGEST_IGNORED_ROLE_TYPES).toEqual(["guest"]);
  });
});

describe("PUT /api/me input validation (FX26)", () => {
  let stub: ReturnType<typeof stubStrapi>;

  beforeEach(() => {
    stub = stubStrapi();
    vi.stubGlobal("strapi", stub.strapi);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const put = (data: unknown) => profile.updateMe(makeCtx(caller("member"), { data }).ctx);
  const written = () => stub.updateCalls[stub.updateCalls.length - 1]?.data;

  it("trims every free-text field before the write", async () => {
    await put({
      displayName: "  Sam C.  ",
      jobTitle: "\tEngineer\n",
      phone: " +49 30 1 ",
      officeLocation: " Remote ",
    });
    expect(written()).toEqual({
      displayName: "Sam C.",
      jobTitle: "Engineer",
      phone: "+49 30 1",
      officeLocation: "Remote",
    });
  });

  it("stores an empty or blank displayName as null, other empty fields as ''", async () => {
    await put({ displayName: "   ", jobTitle: "", phone: " ", officeLocation: "" });
    expect(written()).toEqual({ displayName: null, jobTitle: "", phone: "", officeLocation: "" });
  });

  it("accepts null to clear a field", async () => {
    await put({ displayName: null, jobTitle: null });
    expect(written()).toEqual({ displayName: null, jobTitle: null });
  });

  it.each(PROFILE_TEXT_FIELDS)(
    "rejects %s over 255 characters with 400 and writes nothing",
    async (field) => {
      await expect(put({ [field]: "x".repeat(PROFILE_TEXT_MAX + 1) })).resolves.toBe(
        `400 ${field} must be at most 255 characters`,
      );
      expect(stub.updateCalls).toHaveLength(0);
    },
  );

  it("measures the length after trimming and in characters, as Postgres does", async () => {
    await put({ jobTitle: ` ${"x".repeat(PROFILE_TEXT_MAX)} ` });
    expect((written()!.jobTitle as string).length).toBe(PROFILE_TEXT_MAX);
    // 255 emoji: 510 UTF-16 units, but 255 characters for varchar(255).
    await put({ officeLocation: "\u{1F3E2}".repeat(PROFILE_TEXT_MAX) });
    expect(written()!.officeLocation).toBe("\u{1F3E2}".repeat(PROFILE_TEXT_MAX));
    await expect(put({ officeLocation: "\u{1F3E2}".repeat(PROFILE_TEXT_MAX + 1) })).resolves.toBe(
      "400 officeLocation must be at most 255 characters",
    );
  });

  it.each([42, true, { text: "x" }, ["x"]])(
    "rejects a non-string value (%j) with 400",
    async (value) => {
      await expect(put({ phone: value })).resolves.toBe("400 phone must be a string or null");
      expect(stub.updateCalls).toHaveLength(0);
    },
  );

  it("rejects the whole request when one field is invalid (no partial update)", async () => {
    await expect(
      put({ displayName: "Sam", jobTitle: "x".repeat(300), birthdayVisible: true }),
    ).resolves.toBe("400 jobTitle must be at most 255 characters");
    expect(stub.updateCalls).toHaveLength(0);
  });

  it("accepts the locales en and de only", async () => {
    for (const locale of PROFILE_LOCALES) {
      await put({ locale });
      expect(written()).toEqual({ locale });
    }
    for (const locale of ["fr", "EN", " de", "", null, 1]) {
      stub.updateCalls.length = 0;
      await expect(put({ locale }), String(locale)).resolves.toBe("400 locale must be en or de");
      expect(stub.updateCalls).toHaveLength(0);
    }
  });

  it("keeps the birthday and boolean coercion and lastDigestAt stays out", async () => {
    await put({
      displayName: " Sam ",
      birthday: "1990-02-03",
      birthdayVisible: "on",
      digestAnnouncements: "false",
      lastDigestAt: "2000-01-01T00:00:00.000Z",
    });
    expect(written()).toEqual({
      displayName: "Sam",
      birthday: "1990-02-03",
      birthdayVisible: true,
      digestAnnouncements: false,
    });
  });

  it("ignores inherited keys of the body", async () => {
    const body = Object.create({ displayName: "inherited" }) as Row;
    body.jobTitle = "Engineer";
    await put(body);
    expect(written()).toEqual({ jobTitle: "Engineer" });
  });
});

describe("normalizeProfileText", () => {
  it("leaves absent fields absent and other keys untouched", () => {
    const data: Row = { birthday: "  1990-02-03 ", locale: "de" };
    expect(normalizeProfileText(data)).toBeNull();
    expect(data).toEqual({ birthday: "  1990-02-03 ", locale: "de" });
  });
});

describe("Entra-owned profile fields (D-ENTRA-01)", () => {
  const TENANT = "11111111-2222-4333-8444-555555555555";
  const MANAGED = ["displayName", "jobTitle", "phone", "officeLocation"];
  const bound: Row = {
    entraTenantId: TENANT,
    microsoftOid: "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b",
    roleSource: "entra",
    entraAppliedRole: "member",
    entraManagerOid: "5a5a5a5a-6b6b-4c7c-8d8d-9e9e9e9e9e9e",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET lists the managed fields for a bound user, none for everyone else, and no Entra column", async () => {
    for (const [self, expected] of [
      [bound, MANAGED],
      [{}, []],
      [{ entraTenantId: null, microsoftOid: "legacy-oid" }, []],
      [{ entraTenantId: "" }, []],
    ] as const) {
      vi.stubGlobal("strapi", stubStrapi({ self: { ...self } }).strapi);
      const { ctx, sent } = makeCtx(caller("member"));
      await profile.me(ctx);
      expect(sent()!.entraManagedFields).toEqual(expected);
      for (const key of ENTRA_COLUMNS) expect(sent()).not.toHaveProperty(key);
    }
  });

  it("PUT drops the Entra-owned fields of a bound user and writes the rest", async () => {
    const stub = stubStrapi({ self: bound });
    vi.stubGlobal("strapi", stub.strapi);
    const { ctx, sent } = makeCtx(caller("member"), {
      data: {
        displayName: "Self-chosen",
        jobTitle: "Self-promoted",
        phone: "+1 555",
        officeLocation: "Moon",
        locale: "de",
        birthdayVisible: "on",
      },
    });
    await profile.updateMe(ctx);
    expect(stub.updateCalls).toEqual([
      { where: { id: 1 }, data: { locale: "de", birthdayVisible: true } },
    ]);
    expect(sent()).toMatchObject({
      displayName: "Sam Chen",
      jobTitle: "Engineer",
      locale: "de",
      entraManagedFields: MANAGED,
    });
  });

  it("PUT with only Entra-owned fields writes nothing and answers the profile", async () => {
    const stub = stubStrapi({ self: bound });
    vi.stubGlobal("strapi", stub.strapi);
    const { ctx, sent } = makeCtx(caller("member"), { data: { displayName: "", jobTitle: "" } });
    await profile.updateMe(ctx);
    expect(stub.updateCalls).toEqual([]);
    expect(sent()).toMatchObject({ displayName: "Sam Chen", entraManagedFields: MANAGED });
  });

  it("PUT keeps every field editable for a local (unbound) user", async () => {
    const stub = stubStrapi({ self: { microsoftOid: "legacy-oid" } });
    vi.stubGlobal("strapi", stub.strapi);
    await profile.updateMe(makeCtx(caller("member"), { data: { displayName: "Sam C.", phone: "1" } }).ctx);
    expect(stub.updateCalls[0].data).toEqual({ displayName: "Sam C.", phone: "1" });
  });
});

describe("toSelfProfile / toManagerSummary", () => {
  it("never invents keys that the row does not carry", () => {
    expect(toSelfProfile({ id: 1, username: "a" })).toEqual({ id: 1, username: "a" });
  });

  it("maps unpopulated / null relations to null", () => {
    expect(toSelfProfile({ id: 1, role: null, department: 10, avatar: undefined })).toEqual({
      id: 1,
      role: null,
      department: null,
      avatar: null,
    });
  });

  it("drops the manager key entirely from the self serializer", () => {
    expect(toSelfProfile({ id: 1, manager: MANAGER_ROW })).toEqual({ id: 1 });
  });

  it("returns null for a missing manager and filters a FULL row by role", () => {
    expect(toManagerSummary(null, "member")).toBeNull();
    expect(toManagerSummary(undefined, "member")).toBeNull();
    const full = toManagerSummary(MANAGER_ROW, "member")!;
    expect(Object.keys(full).sort()).toEqual(
      [...MANAGER_SUMMARY_FIELDS, ...MANAGER_CONTACT_FIELDS].sort(),
    );
    const reduced = toManagerSummary(MANAGER_ROW, "guest")!;
    expect(Object.keys(reduced).sort()).toEqual([...MANAGER_SUMMARY_FIELDS].sort());
  });

  it("allowlists never name a secret column or an Entra column", () => {
    for (const list of [SELF_PROFILE_FIELDS, MANAGER_SUMMARY_FIELDS, MANAGER_CONTACT_FIELDS]) {
      for (const key of [...SECRET_KEYS, ...ENTRA_COLUMNS]) {
        expect(list as readonly string[]).not.toContain(key);
      }
    }
    // Manager contact data is exactly the #10-gated kind.
    for (const key of MANAGER_CONTACT_FIELDS) {
      expect(SENSITIVE_USER_FIELDS as readonly string[]).toContain(key);
    }
  });
});
