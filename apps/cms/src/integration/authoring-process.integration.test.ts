import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUser, signIn } from "./admin-api.test.helper";
import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Processes (v1.1 "Tools", BPMN) through the v2 write model on SQLite and
 * Postgres 16: department heads AND team leads author their own department's
 * processes (owner decision 2026-11-19, like duty plans), moderators any
 * process; every staff role and `authenticated` read published ones, guests
 * none. The summary and the diagram (BPMN XML) are checked by the shared
 * rules (@sinnlos/domain process.ts) for every writer, the admin panel
 * included, and the whole payload survives the write path byte-equal.
 */
const PROCESS = "api::process.process";
const USER = "plugin::users-permissions.user";
const P = "processes";
const NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";

const bpmn = (pad = "", label = "Start") =>
  `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="${NS}" id="d"><bpmn:process id="p" isExecutable="false"><bpmn:startEvent id="s" name="${label}"/></bpmn:process><!--${pad}--></bpmn:definitions>`;
const BASE_PROCESS = { title: "Wareneingang", summary: "Ware annehmen, prüfen, einlagern." };
const AUTHOR_ROLES = ["team_lead", "department_head"] as const;

describe.each(testEngines())("authoring processes on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let engineering: Row;
  let sales: Row;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
    engineering = t.fixtures.departments.engineering;
    sales = t.fixtures.departments.sales;
  });
  afterAll(async () => {
    await t?.stop();
  });

  const rowsOf = async (documentId: string) =>
    (await t.strapi.db.query(PROCESS).findMany({
      where: { documentId },
      populate: { department: true, ownerDepartment: true, author: true },
    })) as unknown as (Record<string, unknown> & {
      publishedAt: unknown;
      department: { id: number } | null;
      ownerDepartment: { id: number } | null;
      author: { id: number } | null;
    })[];
  const draftOf = async (documentId: string) =>
    (await rowsOf(documentId)).find((row) => row.publishedAt == null)!;

  /** A process of `department` (null: company-wide) made by an editor. */
  const moderatorProcess = async (department: Row | null, extra: Record<string, unknown> = {}) => {
    const res = await api.create(
      "editor",
      P,
      { ...BASE_PROCESS, diagram: bpmn(), department: department?.documentId ?? null, ...extra },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    return res.body.data;
  };

  describe.each(AUTHOR_ROLES)("%s (department author)", (role) => {
    it("publishes a process for their department: pinned, owned, the caller as author", async () => {
      const res = await api.create(role, P, { ...BASE_PROCESS, diagram: bpmn() }, "published");
      expect(res.status, res.text).toBe(201);
      const rows = await rowsOf(res.body.data.documentId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.department?.id, `${row.publishedAt}`).toBe(engineering.id);
        expect(row.ownerDepartment?.id).toBe(engineering.id);
        expect(row.author?.id).toBe(t.fixtures.users[role].id);
      }
      const form = await api.editable<Record<string, unknown>>(role, P, res.body.data.documentId);
      expect(form.status, form.text).toBe(200);
      expect(form.body.data).toMatchObject({
        roleClass: "departmentAuthor",
        ...BASE_PROCESS,
        diagram: bpmn(),
        department: engineering.documentId,
      });
    });

    it("keeps to their department: a foreign one, forged ownership and a retarget are refused", async () => {
      for (const data of [
        { department: sales.documentId },
        { ownerDepartment: sales.documentId },
        { author: t.fixtures.users.admin_role.id },
      ]) {
        const res = await api.create(
          role,
          P,
          { ...BASE_PROCESS, diagram: bpmn(), ...data },
          "published",
        );
        expect(res.status, JSON.stringify(data)).toBe(400);
        expect(res.body.error?.details, JSON.stringify(data)).toEqual({ keys: Object.keys(data) });
      }
      const own = await api.create(role, P, { ...BASE_PROCESS, diagram: bpmn() }, "published");
      for (const data of [{ department: sales.documentId }, { department: null }]) {
        const retarget = await api.update(role, P, own.body.data.documentId, data, {
          version: own.body.data.version,
          status: "published",
        });
        expect(retarget.status, JSON.stringify(data)).toBe(400);
        expect(retarget.body.error?.details, JSON.stringify(data)).toEqual({
          keys: ["department"],
        });
      }
      expect((await draftOf(own.body.data.documentId)).department?.id).toBe(engineering.id);
    });

    it("cannot reach a foreign or company-wide process: update, editable, transitions, delete", async () => {
      const foreign = await moderatorProcess(sales);
      const wide = await moderatorProcess(null);
      for (const item of [foreign, wide]) {
        const id = item.documentId;
        const update = await api.update(
          role,
          P,
          id,
          { summary: "Übernommen" },
          { version: item.version, status: "published" },
        );
        expect([403, 404], `update ${update.status}`).toContain(update.status);
        expect((await api.editable(role, P, id)).status, "editable").toBe(404);
        for (const action of ["publish", "unpublish", "discard-draft"] as const) {
          expect((await api.action(role, P, id, action, item.version)).status, action).toBe(404);
        }
        expect((await api.remove(role, P, id, item.version)).status, "delete").toBe(403);
        expect((await draftOf(id)).summary).toBe(BASE_PROCESS.summary);
      }
      const list = await api.list<{ documentId: string }>(role, P);
      expect(list.status).toBe(200);
      const ids = list.body.data.map((row) => row.documentId);
      expect(ids).not.toContain(foreign.documentId);
      expect(ids).not.toContain(wide.documentId);
    });

    it("maintains a moderator's process of their department, until it is moved away", async () => {
      const item = await moderatorProcess(engineering);
      expect((await draftOf(item.documentId)).ownerDepartment?.id).toBe(engineering.id);
      const edited = await api.update(
        role,
        P,
        item.documentId,
        { summary: "Neu beschrieben" },
        { version: item.version, status: "published" },
      );
      expect(edited.status, edited.text).toBe(200);
      const list = await api.list<{ documentId: string }>(role, P);
      expect(list.body.data.map((row) => row.documentId)).toContain(item.documentId);
      const unpublished = await api.action(
        role,
        P,
        item.documentId,
        "unpublish",
        edited.body.data.version,
      );
      expect(unpublished.status, unpublished.text).toBe(200);
      // No delete for department authors; a never-published item cannot be discarded away.
      expect(
        (await api.remove(role, P, item.documentId, unpublished.body.data.version)).status,
      ).toBe(403);

      const moved = await api.update(
        "editor",
        P,
        item.documentId,
        { department: sales.documentId },
        { version: unpublished.body.data.version, status: "draft" },
      );
      expect(moved.status, moved.text).toBe(200);
      const after = await api.update(
        role,
        P,
        item.documentId,
        { summary: "Zu spät" },
        { version: moved.body.data.version, status: "draft" },
      );
      expect([403, 404]).toContain(after.status);
      expect((await api.editable(role, P, item.documentId)).status).toBe(404);
    });

    it("answers 403 without a department, on create and on the list", async () => {
      const user = await createUser(t, role, null);
      const jwt = await signIn(t, user);
      const create = await api.create(
        { jwt },
        P,
        { ...BASE_PROCESS, diagram: bpmn() },
        "published",
      );
      expect(create.status).toBe(403);
      expect((await api.list({ jwt }, P)).status).toBe(403);
      // A department that is taken away later closes the door at once.
      const other = await createUser(t, role, engineering);
      const otherJwt = await signIn(t, other);
      const mine = await api.create({ jwt: otherJwt }, P, { ...BASE_PROCESS, diagram: bpmn() });
      expect(mine.status, mine.text).toBe(201);
      await t.strapi.db.query(USER).update({ where: { id: other.id }, data: { department: null } });
      const update = await api.update(
        { jwt: otherJwt },
        P,
        mine.body.data.documentId,
        { summary: "Ohne Abteilung" },
        { version: mine.body.data.version, status: "published" },
      );
      expect([403, 404]).toContain(update.status);
    });
  });

  it("reads: every staff role and authenticated read published processes (no diagram needed in a list), guests none", async () => {
    const item = await api.create(
      "editor",
      P,
      { ...BASE_PROCESS, title: "Lesbar", diagram: bpmn() },
      "published",
    );
    expect(item.status, item.text).toBe(201);
    for (const role of [
      "admin_role",
      "editor",
      "department_head",
      "team_lead",
      "member",
      "authenticated",
    ] as const) {
      const read = await t.api<{ data: { title: string; summary: string }[] }>(
        role,
        "/api/processes?fields[0]=title&fields[1]=summary&fields[2]=updatedAt",
      );
      expect(read.status, role).toBe(200);
      expect(
        read.body.data.find((row) => row.title === "Lesbar"),
        role,
      ).toMatchObject({
        summary: BASE_PROCESS.summary,
      });
      expect(read.body.data[0], role).not.toHaveProperty("diagram");
    }
    expect((await t.api("guest", "/api/processes")).status).toBe(403);
    // members author nothing
    expect((await api.create("member", P, { ...BASE_PROCESS, diagram: bpmn() })).status).toBe(403);
    expect((await api.list("member", P)).status).toBe(403);
  });

  it("refuses an invalid summary and diagram with field codes, for every author role", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ summary: "  " }, { keys: ["summary"], codes: { summary: "required" } }],
      [{ summary: "s".repeat(2001) }, { keys: ["summary"], codes: { summary: "tooLong" } }],
      [{ diagram: "<html></html>" }, { keys: ["diagram"], codes: { diagram: "invalid" } }],
      [
        { diagram: `<!DOCTYPE d [<!ENTITY a "b">]>${bpmn()}` },
        { keys: ["diagram"], codes: { diagram: "invalid" } },
      ],
      [{ diagram: bpmn("\u0001") }, { keys: ["diagram"], codes: { diagram: "invalid" } }],
      [{ diagram: bpmn("\ud800") }, { keys: ["diagram"], codes: { diagram: "invalid" } }],
      [
        { diagram: bpmn("a".repeat(300_001)) },
        { keys: ["diagram"], codes: { diagram: "tooLong" } },
      ],
      // 125 000 x U+0001 is 750 000 bytes JSON-escaped: over the 700 KiB rule, under 1 MiB; the
      // character rule answers (180 000 of them would be a 413 at koa-body).
      [
        { diagram: bpmn("\u0001".repeat(125_000)) },
        { keys: ["diagram"], codes: { diagram: "invalid" } },
      ],
      [{ diagram: 7 }, { keys: ["diagram"], codes: { diagram: "invalid" } }],
      // A paint that is no plain color: Chromium requests the address (bpmn-js 18.33.0), in the
      // viewer and in an exported .svg opened as a file. Matched by local name, any prefix.
      ...[
        'bioc:stroke="url(https://evil.example/x.svg#a)"',
        'zz:fill = "url(http://evil.example/y.svg#b)"',
        'color:border-color="&#117;rl(https://evil.example/z)"',
      ].map((attribute): [Record<string, unknown>, Record<string, unknown>] => [
        { diagram: bpmn().replace("<bpmn:startEvent ", `<bpmn:startEvent ${attribute} `) },
        { keys: ["diagram"], codes: { diagram: "invalid" } },
      ]),
      [{ title: "t".repeat(256) }, { keys: ["title"], codes: { title: "tooLong" } }],
    ];
    for (const role of ["editor", ...AUTHOR_ROLES] as const) {
      for (const [data, details] of cases) {
        const res = await api.create(
          role,
          P,
          { ...BASE_PROCESS, diagram: bpmn(), ...data },
          "published",
        );
        expect(res.status, `${role} ${JSON.stringify(data).slice(0, 60)}`).toBe(400);
        expect(res.body.error?.details, JSON.stringify(data).slice(0, 60)).toEqual(details);
      }
    }
  });

  it("stores the size limits exactly: 300 000 characters in, 300 001 out; 700 KiB serialized in, one byte more out", async () => {
    const wrapper = bpmn().length;
    const ok = await api.create(
      "department_head",
      P,
      { ...BASE_PROCESS, diagram: bpmn("a".repeat(300_000 - wrapper)) },
      "draft",
    );
    expect(ok.status, ok.text).toBe(201);
    const over = await api.create(
      "department_head",
      P,
      { ...BASE_PROCESS, diagram: bpmn("a".repeat(300_001 - wrapper)) },
      "draft",
    );
    expect(over.body.error?.details).toEqual({ keys: ["diagram"], codes: { diagram: "tooLong" } });

    // Three-byte characters reach the byte limit well below 300 000 characters. Maximal payload:
    // title 255, summary 2000, diagram at the byte limit; no 413.
    const MAX_BYTES = 700 * 1024;
    const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");
    const room = MAX_BYTES - jsonBytes(bpmn());
    const padOf = (extra: number) =>
      "€".repeat(Math.floor(room / 3)) + "a".repeat((room % 3) + extra);
    const exact = bpmn(padOf(0));
    expect(jsonBytes(exact)).toBe(MAX_BYTES);
    const maximal = await api.create(
      "editor",
      P,
      { title: "t".repeat(255), summary: "s".repeat(2000), diagram: exact },
      "published",
    );
    expect(maximal.status, maximal.text.slice(0, 300)).toBe(201);
    expect((await draftOf(maximal.body.data.documentId)).diagram).toBe(exact);
    const tooBig = await api.create(
      "editor",
      P,
      { ...BASE_PROCESS, diagram: bpmn(padOf(1)) },
      "draft",
    );
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error?.details).toEqual({
      keys: ["diagram"],
      codes: { diagram: "tooLong" },
    });
  });

  it("round-trips 299 999 characters of ASCII, umlauts, emoji, quotes and backslashes byte-equal", async () => {
    const unit = 'aä\u{1f642}"\\';
    const label = `Prüfen "ja" \\ nein ä \u{1f642}`;
    const head = bpmn("", label);
    // The pad (inside the comment) fills the rest up to 299 999 characters.
    let pad = "";
    const room = 299_999 - head.length;
    while (pad.length + unit.length <= room) pad += unit;
    pad += "x".repeat(room - pad.length);
    const diagram = bpmn(pad, label);
    expect(diagram.length).toBe(299_999);
    const created = await api.create(
      "team_lead",
      P,
      { ...BASE_PROCESS, summary: "Größe: 299 999 \u{1f642}", diagram },
      "published",
    );
    expect(created.status, created.text.slice(0, 300)).toBe(201);
    const stored = await draftOf(created.body.data.documentId);
    expect(stored.diagram).toBe(diagram);
    const form = await api.editable<{ diagram: string; summary: string }>(
      "team_lead",
      P,
      created.body.data.documentId,
    );
    expect(form.body.data.diagram).toBe(diagram);
    expect(form.body.data.summary).toBe("Größe: 299 999 \u{1f642}");
    const read = await t.api<{ data: { diagram: string }[] }>(
      "member",
      `/api/processes?filters[documentId][$eq]=${created.body.data.documentId}`,
    );
    expect(read.body.data[0]?.diagram).toBe(diagram);
  });

  it("validates admin-panel and Document Service writes too (the lifecycle)", async () => {
    const documents = t.strapi.documents(PROCESS);
    await expect(
      documents.create({ data: { ...BASE_PROCESS, diagram: "<html/>" } }),
    ).rejects.toThrow(/diagram: invalid/);
    await expect(
      documents.create({ data: { ...BASE_PROCESS, diagram: bpmn("a".repeat(300_001)) } }),
    ).rejects.toThrow(/diagram: tooLong/);
    await expect(
      documents.create({ data: { title: "Leer", summary: "   ", diagram: bpmn() } }),
    ).rejects.toThrow(/summary: required/);
    const created = await documents.create({ data: { ...BASE_PROCESS, diagram: bpmn() } });
    await expect(
      documents.update({ documentId: created.documentId, data: { diagram: "plain" } }),
    ).rejects.toThrow(/diagram: invalid/);
    await expect(
      documents.update({ documentId: created.documentId, data: { summary: "s".repeat(2001) } }),
    ).rejects.toThrow(/summary: tooLong/);
    expect((await draftOf(created.documentId)).diagram).toBe(bpmn());
    // An unrelated admin edit keeps the stored diagram and passes.
    await documents.update({ documentId: created.documentId, data: { title: "Umbenannt" } });
    expect((await draftOf(created.documentId)).title).toBe("Umbenannt");
  });
});
