import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAdminDetail } from "@sinnlos/domain";

/**
 * v0.30: the five buttons whose Server Action call can reject (a deploy
 * restart, a lost connection) show their inline failure, and the rejection
 * never escapes the transition (it would replace the page with the error
 * page). The components run under a shallow hook shim: each one is called
 * as a function, its handlers are taken from the elements it returns (the
 * dialogs are not rendered), and every state update is recorded. The
 * same shim shows the anonymisation's result text.
 */
const shim = vi.hoisted(() => ({
  index: 0,
  seed: new Map<number, unknown>(),
  updates: [] as unknown[],
  transitions: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = shim.index++;
    const value = shim.seed.has(index) ? shim.seed.get(index) : initial;
    return [value, (next: unknown) => shim.updates.push(next)];
  },
  useTransition: () => [false, (run: () => unknown) => shim.transitions.push(run())],
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}#${values.count}`,
  useFormatter: () => ({ dateTime: () => "" }),
}));
const failure = () => Promise.reject(new TypeError("fetch failed"));
vi.mock("@/lib/manage/user-actions", () => ({
  sendLink: vi.fn(failure),
  resetUserMfa: vi.fn(failure),
  previewAnonymisation: vi.fn(failure),
  anonymiseUser: vi.fn(failure),
}));
vi.mock("@/lib/classified-actions", () => ({ renewClassified: vi.fn(failure) }));

const { UserAccountActions } = await import("./user-account-actions");
const { UserDataProtection } = await import("./user-data-protection");
const { RenewButton } = await import("@/components/marketplace/renew-button");

type Props = Record<string, unknown> & { children?: ReactNode };

/** The first element in `node` (props.children, depth first) that `match` accepts. */
function find(node: ReactNode, match: (props: Props) => boolean): Props {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) queue.unshift(...next);
    else if (isValidElement(next)) {
      const props = (next as ReactElement<Props>).props;
      if (match(props)) return props;
      queue.unshift(props.children);
    }
  }
  throw new Error("no such element");
}

/** Calls `component` with `props`, the `seed` states in place of their initial values. */
function shallow<P>(component: (props: P) => ReactNode, props: P, seed: unknown[] = []) {
  shim.index = 0;
  shim.seed = new Map(seed.flatMap((value, i) => (value === undefined ? [] : [[i, value]])));
  return component(props);
}

const person = (patch: Partial<UserAdminDetail>) =>
  ({
    id: 7,
    idp: null,
    invited: false,
    mfa: true,
    self: false,
    anonymisedAt: null,
    ...patch,
  }) as UserAdminDetail;
const preview = { username: "former", counts: { rewritten: { notifications: 0 } } };

const cases: { name: string; press: () => void; shows: unknown }[] = [
  {
    name: "a new sign-in link",
    press: () => {
      const tree = shallow(UserAccountActions, {
        user: person({ blocked: false }),
        localSignIn: true,
      });
      (find(tree, (p) => p.confirmLabel === "link.confirm").onConfirm as () => void)();
    },
    shows: { ok: false, text: "link.error.failed" },
  },
  {
    name: "the second-factor reset",
    press: () => {
      const tree = shallow(UserAccountActions, {
        user: person({ blocked: false }),
        localSignIn: true,
      });
      (find(tree, (p) => p.confirmLabel === "mfaReset.confirm").onConfirm as () => void)();
    },
    shows: { ok: false, text: "mfaReset.failed" },
  },
  {
    name: "the anonymisation preview",
    press: () => {
      const tree = shallow(UserDataProtection, {
        user: person({ blocked: true }),
        trainingEvidence: false,
      });
      (find(tree, (p) => "onOpenChange" in p).onOpenChange as (open: boolean) => void)(true);
    },
    shows: "error.failed",
  },
  {
    name: "the anonymisation",
    press: () => {
      const tree = shallow(
        UserDataProtection,
        { user: person({ blocked: true }), trainingEvidence: false },
        [true, preview, "former"],
      );
      (find(tree, (p) => p.children === "anonymise.confirm").onClick as () => void)();
    },
    shows: "error.failed",
  },
  {
    name: "renewing an ad",
    press: () => {
      const tree = shallow(RenewButton, { id: 3 });
      (find(tree, (p) => p.type === "button").onClick as () => void)();
    },
    shows: true,
  },
];

describe("an action whose call rejects", () => {
  beforeEach(() => {
    shim.updates = [];
    shim.transitions = [];
  });

  it.each(cases)("$name shows its inline failure", async ({ press, shows }) => {
    press();
    const settled = await Promise.allSettled(shim.transitions);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled"]);
    expect(shim.updates).toContainEqual(shows);
  });
});

describe("the anonymisation's result", () => {
  /** The status line after an anonymisation whose rewrite left `remaining` notifications. */
  const status = (remaining: number) => {
    const done = {
      id: 7,
      anonymisedAt: "2026-10-26T10:00:00.000Z",
      avatar: null,
      notifications: { rewritten: 3, remaining },
    };
    const tree = shallow(
      UserDataProtection,
      { user: person({ blocked: true }), trainingEvidence: false },
      [false, null, "", null, done],
    );
    const line = find(tree, (p) => JSON.stringify(p.children ?? "").includes("anonymise.done"));
    return JSON.stringify(line.children);
  };

  it("names the notifications still pending, chosen by the count alone", () => {
    expect(status(0)).not.toContain("anonymise.remaining");
    expect(status(2)).toContain("anonymise.remaining#2");
  });
});
