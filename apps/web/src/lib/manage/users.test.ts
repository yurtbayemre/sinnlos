import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAdminDetail } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { parseUserListQuery } from "@/lib/loaders/manage/users";
import { buildUserPayload, coerceUserValues, userValuesFromDetail } from "./user-values";

const strapi = vi.fn();
const refresh = vi.fn();
let viewer: Viewer;
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refresh() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
const { saveUser, handRoleToEntra, inviteUser, sendLink, resetUserMfa } =
  await import("./user-actions");
const { parseInviteLines, sendOpenInvites } = await import("@/components/manage/user-invite-form");

const DEPT = "dept00000000000000000001";
const user: UserAdminDetail = {
  id: 12,
  documentId: "user00000000000000000012",
  displayName: "Casey Jones",
  email: "casey@example.test",
  role: "member",
  roleSource: "manual",
  idp: null,
  invited: false,
  mfa: false,
  blocked: false,
  department: { documentId: DEPT, name: "Design" },
  manager: { id: 3, displayName: "Riley Kim" },
  teams: [],
  createdAt: null,
  self: false,
  locked: { department: false, manager: false },
};
const initial = userValuesFromDetail(user);
const cmsError = (status: number, details = {}) =>
  new StrapiError(status, "Error", JSON.stringify({ error: { status, details } }));
const body = () => JSON.parse(strapi.mock.calls.at(-1)![1].body).data;

beforeEach(() => {
  viewer = { id: 1, role: "admin_role", displayName: "Alex", department: null };
  strapi.mockReset().mockResolvedValue({ data: user });
  refresh.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("user values (v0.23)", () => {
  it("reads the detail and sends only what changed", () => {
    expect(initial).toEqual({ role: "member", department: DEPT, manager: 3, blocked: false });
    expect(buildUserPayload(initial, initial)).toEqual({});
    expect(
      buildUserPayload({ role: "editor", department: "", manager: null, blocked: true }, initial),
    ).toEqual({ role: "editor", department: null, manager: null, blocked: true });
    // A user without a role keeps "" until a role is picked; "" is never sent.
    expect(buildUserPayload({ ...initial, role: "" }, initial)).toEqual({});
  });
  it("coerces exactly the form's shape", () => {
    expect(coerceUserValues(initial)).toEqual(initial);
    for (const bad of [
      null,
      [],
      { ...initial, role: "public" },
      { ...initial, role: "Admin_role" },
      { ...initial, department: null },
      { ...initial, manager: 0 },
      { ...initial, manager: "3" },
      { ...initial, blocked: "true" },
    ])
      expect(coerceUserValues(bad), JSON.stringify(bad)).toBeNull();
  });
  it("forwards only known list parameters", () => {
    expect(
      parseUserListQuery({ q: "  casey ", role: "editor", blocked: "true", page: "2", x: "1" }),
    ).toEqual({ q: "casey", role: "editor", blocked: "true", page: 2 });
    expect(
      parseUserListQuery({ q: ["a", "b"], role: "public", blocked: "yes", page: "1" }),
    ).toEqual({});
    expect(parseUserListQuery({ q: "x".repeat(300) }).q).toHaveLength(100);
  });
});

describe("user actions (v0.23)", () => {
  it("saves one PUT with only the changed fields and refreshes", async () => {
    await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(strapi).toHaveBeenCalledWith(
      "/api/user-management/12",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(body()).toEqual({ blocked: true });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("an unchanged form sends nothing", async () => {
    await expect(saveUser(12, initial, initial)).resolves.toEqual({ ok: true, data: null });
    expect(strapi).not.toHaveBeenCalled();
  });
  it("maps a refusal to the field", async () => {
    strapi.mockRejectedValueOnce(
      cmsError(400, { keys: ["blocked"], codes: { blocked: "selfChange" } }),
    );
    await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toMatchObject({
      ok: false,
      code: "invalid",
      fields: { blocked: "selfChange" },
    });
  });
  it("hands the role back with one POST", async () => {
    await expect(handRoleToEntra(12)).resolves.toEqual({ ok: true, data: null });
    expect(strapi).toHaveBeenCalledWith(
      "/api/user-management/12/role-to-entra",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it.each(["editor", "department_head", "team_lead", "member", "guest", null])(
    "refuses %s before any request",
    async (role) => {
      viewer.role = role;
      await expect(saveUser(12, { ...initial, blocked: true }, initial)).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
      await expect(handRoleToEntra(12)).resolves.toEqual({ ok: false, code: "forbidden" });
      expect(strapi).not.toHaveBeenCalled();
    },
  );
  it("refuses a bad id or malformed values before any request", async () => {
    for (const id of [0, -1, 1.5, "12", null])
      await expect(saveUser(id, initial, initial)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    await expect(saveUser(12, { ...initial, role: "public" }, initial)).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    viewer.id = null;
    await expect(handRoleToEntra(12)).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(strapi).not.toHaveBeenCalled();
  });
});

describe("invitations, links and the 2FA reset (v0.27)", () => {
  const invite = {
    email: " ada@example.test ",
    displayName: "Ada",
    role: "member",
    department: DEPT,
  };

  it("invites with the trimmed body and answers sent or mailFailed", async () => {
    strapi.mockResolvedValue({ data: { id: 40, mail: "sent" } });
    await expect(inviteUser(invite)).resolves.toBe("sent");
    expect(strapi.mock.calls.at(-1)![0]).toBe("/api/user-management/invite");
    expect(body()).toEqual({
      email: "ada@example.test",
      displayName: "Ada",
      role: "member",
      department: DEPT,
    });
    strapi.mockResolvedValue({ data: { id: 41, mail: "failed" } });
    await expect(inviteUser({ ...invite, displayName: "" })).resolves.toBe("mailFailed");
    expect(body()).toEqual({ email: "ada@example.test", role: "member", department: DEPT });
  });

  it.each([
    ["a taken address", cmsError(400, { keys: ["email"], codes: { email: "taken" } }), "taken"],
    ["local sign-in off", cmsError(400, { codes: { _form: "localSignInOff" } }), "localSignInOff"],
    [
      "no mail set up",
      cmsError(400, { codes: { _form: "mailNotConfigured" } }),
      "mailNotConfigured",
    ],
    ["case duplicates", cmsError(409, { code: "email_duplicates_exist" }), "emailDuplicates"],
    ["another refusal", cmsError(400, { keys: ["role"] }), "invalid"],
    ["an outage", cmsError(503), "failed"],
  ])("maps %s", async (_label, error, outcome) => {
    strapi.mockRejectedValue(error);
    await expect(inviteUser(invite)).resolves.toBe(outcome);
  });

  it("refuses a malformed body or a non-admin without a request", async () => {
    await expect(inviteUser({ ...invite, email: "no-at" })).resolves.toBe("invalid");
    await expect(inviteUser({ ...invite, role: "superuser" })).resolves.toBe("invalid");
    await expect(inviteUser({ ...invite, department: "x" })).resolves.toBe("invalid");
    viewer.role = "editor";
    await expect(inviteUser(invite)).resolves.toBe("failed");
    expect(strapi).not.toHaveBeenCalled();
  });

  it("sends a link and maps the cms's refusals", async () => {
    strapi.mockResolvedValue({ data: { id: 12, mail: "sent" } });
    await expect(sendLink(12)).resolves.toEqual({ ok: true, data: null });
    expect(strapi.mock.calls.at(-1)![0]).toBe("/api/user-management/12/send-link");
    strapi.mockResolvedValue({ data: { id: 12, mail: "failed" } });
    await expect(sendLink(12)).resolves.toEqual({ ok: false, code: "mailFailed" });
    strapi.mockRejectedValue(cmsError(400, { codes: { _form: "notLocal" } }));
    await expect(sendLink(12)).resolves.toEqual({ ok: false, code: "notLocal" });
  });

  it("resets the second factor and re-renders", async () => {
    await expect(resetUserMfa(12)).resolves.toEqual({ ok: true, data: null });
    expect(strapi.mock.calls.at(-1)![0]).toBe("/api/user-management/12/reset-mfa");
    expect(refresh).toHaveBeenCalled();
  });

  it("reads one person per line: address and an optional name", () => {
    const text = [
      "ada@example.test;Ada Lovelace",
      "",
      " bob@example.test ",
      "not-an-address",
      "ADA@example.test",
    ].join("\n");
    expect(parseInviteLines(text)).toEqual([
      { email: "ada@example.test", name: "Ada Lovelace", valid: true },
      { email: "bob@example.test", name: "", valid: true },
      { email: "not-an-address", name: "", valid: false },
      { email: "ADA@example.test", name: "", valid: false },
    ]);
    const many = Array.from({ length: 150 }, (_, i) => `u${i}@x.test`).join("\n");
    expect(parseInviteLines(many)).toHaveLength(100);
  });
});

describe("the bulk invitation loop and a stale session (v0.27)", () => {
  const row = (email: string, extra = {}) => ({ email, name: "", valid: true, ...extra });

  it("keeps going after a call that throws, and a retry sends only the open rows", async () => {
    const rows = [row("a@x.test"), row("b@x.test"), row("c@x.test"), row("bad", { valid: false })];
    const results: [number, string][] = [];
    const invite = vi.fn(async (r: { email: string }) => {
      if (r.email === "b@x.test") throw new TypeError("fetch failed");
      return "sent" as const;
    });
    await sendOpenInvites(rows, invite, (index, outcome) => results.push([index, outcome]));
    expect(results).toEqual([
      [0, "sent"],
      [1, "failed"],
      [2, "sent"],
    ]);
    invite.mockClear();
    const after = rows.map((r, i) => ({ ...r, outcome: results.find(([j]) => j === i)?.[1] }));
    await sendOpenInvites(after as never, invite, () => undefined);
    expect(invite.mock.calls.map(([r]) => r.email)).toEqual(["b@x.test"]);
  });

  it("lets a stale session's redirect through instead of a form error (session_outdated)", async () => {
    // strapi() turns the cms's 401 session_outdated into the sign-in redirect.
    const { redirect } = await vi.importActual<typeof import("next/navigation")>("next/navigation");
    let signInRedirect: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      signInRedirect = error;
    }
    strapi.mockRejectedValue(signInRedirect);
    await expect(saveUser(12, { ...initial, role: "editor" }, initial)).rejects.toBe(
      signInRedirect,
    );
    await expect(
      inviteUser({ email: "ada@example.test", role: "member", department: null }),
    ).rejects.toBe(signInRedirect);
    await expect(sendLink(12)).rejects.toBe(signInRedirect);
    await expect(resetUserMfa(12)).rejects.toBe(signInRedirect);
  });
});
