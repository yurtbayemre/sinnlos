import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretShareDetail, SecretShareSummary } from "@sinnlos/domain";

/**
 * The secret pages by role (v0.36, docs/plan-secret-sharing-by-role.md
 * §2.3): "New secret" and /secrets/new only for SECRETS_SEND_ROLES, the
 * received section and the reveal only for SECRETS_RECEIVE_ROLES; the sent
 * section with revoke for every staff member. Unset lists are all staff.
 *
 * The reads, the viewer and the translations are mocked; the pages'
 * returned element trees are searched, not rendered.
 */
const viewer = vi.hoisted(() => ({ role: "member" as string | null }));
const share = vi.hoisted(() => ({ detail: null as unknown }));

vi.mock("@/lib/loaders/secrets", () => ({
  sentPageOf: () => 1,
  loadSecretList: async () => ({ received: [], sent: [], hasMore: false }),
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

const has = (tree: Element[], type: unknown) => tree.some((element) => element.type === type);
const texts = (tree: Element[]) => tree.flatMap((element) => [element.props.children].flat());
const list = async () => elements(await listPage({ searchParams: Promise.resolve({}) }));
const detail = async () => elements(await detailPage({ params: Promise.resolve({ id: "x" }) }));

const PENDING: SecretShareDetail = {
  id: "abcdefghijklmnopqrstuvwx",
  direction: "received",
  counterpart: null,
  createdAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-02T11:00:00.000Z",
  state: "pending",
  terminalAt: null,
  available: true,
};

beforeEach(() => {
  viewer.role = "member";
  share.detail = PENDING;
  vi.stubEnv("SECRETS_SEND_ROLES", "department_head,team_lead");
  vi.stubEnv("SECRETS_RECEIVE_ROLES", "team_lead");
});
afterEach(() => vi.unstubAllEnvs());

describe("/secrets", () => {
  it("a sender who also receives gets the button and both sections", async () => {
    viewer.role = "team_lead";
    const tree = await list();
    expect(tree.some((element) => element.props.href === "/secrets/new")).toBe(true);
    expect(texts(tree)).toEqual(expect.arrayContaining(["secrets.received", "secrets.sent"]));
  });

  it("someone who can do neither keeps the sent section only", async () => {
    const tree = await list();
    expect(has(tree, SectionUnavailablePage)).toBe(false);
    expect(tree.some((element) => element.props.href === "/secrets/new")).toBe(false);
    expect(texts(tree)).toContain("secrets.sent");
    expect(texts(tree)).not.toContain("secrets.received");
  });

  it("a guest still gets the role page", async () => {
    viewer.role = "guest";
    expect(has(await list(), SectionUnavailablePage)).toBe(true);
  });
});

describe("/secrets/new", () => {
  it.each(["department_head", "team_lead"])("%s gets the form", async (role) => {
    viewer.role = role;
    const tree = elements(await newPage());
    expect(has(tree, NewSecretForm)).toBe(true);
  });

  it.each(["admin_role", "member", "guest", null])("%j gets the role page", async (role) => {
    viewer.role = role;
    const tree = elements(await newPage());
    expect(has(tree, SectionUnavailablePage)).toBe(true);
    expect(has(tree, NewSecretForm)).toBe(false);
  });

  it("with the lists unset every staff role gets the form, as in v0.35", async () => {
    vi.stubEnv("SECRETS_SEND_ROLES", "");
    viewer.role = "member";
    expect(has(elements(await newPage()), NewSecretForm)).toBe(true);
  });
});

describe("/secrets/<id> from the bell", () => {
  const state = (tree: Element[]) =>
    tree.find((element) => element.type === SecretState)?.props.share as SecretShareSummary;

  it("a recipient in the receive list can open it", async () => {
    viewer.role = "team_lead";
    const tree = await detail();
    expect(has(tree, RevealSecret)).toBe(true);
    expect(state(tree).available).toBe(true);
  });

  it("a recipient outside it sees the share as not available, without the reveal", async () => {
    const tree = await detail();
    expect(has(tree, RevealSecret)).toBe(false);
    expect(state(tree)).toMatchObject({ state: "pending", available: false });
  });
});
