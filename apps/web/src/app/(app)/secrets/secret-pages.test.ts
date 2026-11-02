import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretShareDetail, SecretShareSummary } from "@sinnlos/domain";

/**
 * The secret pages by role (v0.36, docs/plan-secret-sharing-by-role.md
 * §2.3): "New secret" and /secrets/new only for SECRETS_SEND_ROLES, the
 * received section and the reveal only for SECRETS_RECEIVE_ROLES; the sent
 * section with revoke for every staff member. Unset or empty lists are all
 * staff.
 *
 * The lists below give each role its own combination, so a swapped send
 * and receive check fails. The reads (one pending share in each direction),
 * the viewer and the translations are mocked; the pages' returned element
 * trees are searched, not rendered.
 */
const viewer = vi.hoisted(() => ({ role: "member" as string | null }));
const share = vi.hoisted(() => ({ detail: null as unknown }));

const PENDING: SecretShareSummary = {
  id: "abcdefghijklmnopqrstuvwx",
  counterpart: null,
  createdAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-02T11:00:00.000Z",
  state: "pending",
  terminalAt: null,
  available: true,
};

vi.mock("@/lib/loaders/secrets", () => ({
  sentPageOf: () => 1,
  loadSecretList: async () => ({ received: [PENDING], sent: [PENDING], hasMore: false }),
  loadSecretDetail: async () => share.detail,
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: viewer.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const { SectionUnavailablePage } = await import("@/components/section-unavailable");
const { NewSecretForm } = await import("@/components/secrets/new-secret-form");
const { RevealSecret } = await import("@/components/secrets/reveal-secret");
const { RevokeSecret } = await import("@/components/secrets/revoke-secret");
const { SecretState } = await import("@/components/secrets/secret-state");
const listPage = (await import("./page")).default;
const newPage = (await import("./new/page")).default;
const detailPage = (await import("./[id]/page")).default;

type Element = { type: unknown; props: Record<string, unknown> };

/** Every element in a returned page tree (through children). */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const count = (tree: Element[], type: unknown) =>
  tree.filter((element) => element.type === type).length;
const texts = (tree: Element[]) => tree.flatMap((element) => [element.props.children].flat());
const hrefs = (tree: Element[]) => tree.map((element) => element.props.href);
const list = async () => elements(await listPage({ searchParams: Promise.resolve({}) }));
const detail = async () => elements(await detailPage({ params: Promise.resolve({ id: "x" }) }));
const shownState = (tree: Element[]) =>
  tree.find((element) => element.type === SecretState)?.props.share as SecretShareSummary;

/** The page's view of one viewer: what they can send, receive and revoke. */
async function view() {
  const listed = await list();
  share.detail = { ...PENDING, direction: "received" } satisfies SecretShareDetail;
  const received = await detail();
  // The cms reports a sent share whose recipient may not receive as unavailable.
  share.detail = { ...PENDING, direction: "sent", available: false } satisfies SecretShareDetail;
  const sent = await detail();
  return {
    button: hrefs(listed).includes("/secrets/new"),
    form: count(elements(await newPage()), NewSecretForm) === 1,
    inbox: texts(listed).includes("secrets.received"),
    inboxLinks: texts(listed).filter((text) => text === "secrets.fromName").length,
    revokeInList: count(listed, RevokeSecret),
    sentSection: texts(listed).includes("secrets.sent"),
    reveal: count(received, RevealSecret) === 1,
    receivedAvailable: shownState(received).available,
    sentDetail: {
      revoke: count(sent, RevokeSecret),
      reveal: count(sent, RevealSecret),
      available: shownState(sent).available,
    },
  };
}

beforeEach(() => {
  viewer.role = "member";
  vi.stubEnv("SECRETS_SEND_ROLES", "department_head,team_lead");
  vi.stubEnv("SECRETS_RECEIVE_ROLES", "team_lead,member");
});
afterEach(() => vi.unstubAllEnvs());

describe("the secret pages by role", () => {
  it.each([
    ["team_lead", true, true],
    ["department_head", true, false],
    ["member", false, true],
    ["editor", false, false],
    ["admin_role", false, false],
  ])("%s: send %s, receive %s; the sent list and revoke always", async (role, send, receive) => {
    viewer.role = role;
    expect(await view()).toEqual({
      button: send,
      form: send,
      inbox: receive,
      inboxLinks: receive ? 1 : 0,
      revokeInList: 1,
      sentSection: true,
      reveal: receive,
      receivedAvailable: receive,
      sentDetail: { revoke: 1, reveal: 0, available: false },
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("with both lists %s every staff role sends and receives, as in v0.35", async (_, value) => {
    vi.stubEnv("SECRETS_SEND_ROLES", value);
    vi.stubEnv("SECRETS_RECEIVE_ROLES", value);
    for (const role of ["admin_role", "editor", "department_head", "team_lead", "member"]) {
      viewer.role = role;
      const seen = await view();
      expect([seen.button, seen.form, seen.inbox, seen.reveal, seen.revokeInList], role).toEqual([
        true,
        true,
        true,
        true,
        1,
      ]);
    }
  });

  it("a guest gets the role page on all three", async () => {
    viewer.role = "guest";
    share.detail = { ...PENDING, direction: "received" } satisfies SecretShareDetail;
    for (const tree of [await list(), elements(await newPage()), await detail()]) {
      expect(count(tree, SectionUnavailablePage)).toBe(1);
    }
  });

  it("a role that could not be read gets no form, inbox or reveal (fail-closed)", async () => {
    viewer.role = null;
    const seen = await view();
    expect([seen.button, seen.form, seen.inbox, seen.reveal]).toEqual([false, false, false, false]);
    expect(seen.revokeInList).toBe(1);
  });
});
