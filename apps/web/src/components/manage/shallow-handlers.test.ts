import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAdminDetail } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import type { Notification } from "@/lib/types";

/**
 * v0.30 handlers driven under a shallow hook shim: each component is called
 * as a function, its handlers are taken from the elements it returns (the
 * dialogs and menus are not rendered), and every state update and
 * transition is recorded.
 *
 *  - The five buttons whose Server Action call can reject (a deploy
 *    restart, a lost connection) show their inline failure, and the
 *    rejection never escapes the transition (it would replace the page with
 *    the error page).
 *  - The anonymisation's result text.
 *  - Enter in the document form of a create whose options failed.
 *  - The bell asks before it leaves an editor with unsaved changes.
 */
const shim = vi.hoisted(() => ({
  index: 0,
  seed: new Map<number, unknown>(),
  updates: [] as unknown[],
  /** [state index, value] of every update. */
  sets: [] as [number, unknown][],
  transitions: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = shim.index++;
    const value = shim.seed.has(index) ? shim.seed.get(index) : initial;
    return [
      value,
      (next: unknown) => {
        shim.updates.push(next);
        shim.sets.push([index, next]);
      },
    ];
  },
  useTransition: () => [false, (run: () => unknown) => shim.transitions.push(run())],
  useCallback: (fn: unknown) => fn,
  useMemo: (make: () => unknown) => make(),
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useId: () => "id",
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}#${values.count}`,
  useFormatter: () => ({ dateTime: () => "" }),
  useLocale: () => "en",
  useTimeZone: () => "Europe/Berlin",
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => router,
}));
const guard = vi.hoisted(() => ({ leave: true }));
vi.mock("./unsaved-guard", () => ({
  confirmLeave: () => guard.leave,
  useUnsavedGuard: () => () => {},
}));
vi.mock("./flash", () => ({ useManageFlash: () => () => {}, showFlash: () => {} }));
const failure = () => Promise.reject(new TypeError("fetch failed"));
vi.mock("@/lib/manage/user-actions", () => ({
  sendLink: vi.fn(failure),
  resetUserMfa: vi.fn(failure),
  previewAnonymisation: vi.fn(failure),
  anonymiseUser: vi.fn(failure),
}));
vi.mock("@/lib/classified-actions", () => ({ renewClassified: vi.fn(failure) }));
const writes = vi.hoisted(() => ({ save: vi.fn(), upload: vi.fn(), markRead: vi.fn() }));
vi.mock("@/lib/manage/document-actions", () => ({
  saveDocument: writes.save,
  publishDocument: vi.fn(),
  unpublishDocument: vi.fn(),
  discardDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock("@/lib/manage/upload", () => ({
  uploadDocumentFile: writes.upload,
  uploadImageFile: writes.upload,
}));
vi.mock("@/lib/manage/org-actions", () => ({
  createOrg: vi.fn(),
  saveOrg: vi.fn(),
  deleteOrg: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/notification-actions", () => ({
  markNotificationsRead: writes.markRead,
  markAllNotificationsRead: vi.fn(),
}));

const { UserAccountActions } = await import("./user-account-actions");
const { UserDataProtection } = await import("./user-data-protection");
const { RenewButton } = await import("@/components/marketplace/renew-button");
const { DocumentEditor } = await import("./document-editor");
const { NotificationBell } = await import("@/components/notifications/notification-bell");
const { OrgEditor } = await import("./org-editor");

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

beforeEach(() => {
  shim.updates = [];
  shim.sets = [];
  shim.transitions = [];
  guard.leave = true;
  vi.clearAllMocks();
});

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
  it.each(cases)("$name shows its inline failure", async ({ press, shows }) => {
    press();
    const settled = await Promise.allSettled(shim.transitions);
    expect(settled.map((result) => result.status)).toEqual(["fulfilled"]);
    expect(shim.updates).toContainEqual(shows);
  });
});

describe("the anonymisation's result", () => {
  /** The status line after an anonymisation whose rewrite left `remaining` notifications. */
  const status = (
    remaining: number | null,
    avatar: { id: number; removed: boolean } | null = null,
  ) => {
    const done = {
      id: 7,
      anonymisedAt: "2026-10-26T10:00:00.000Z",
      avatar,
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
    // The final count failed: some may be pending, without a number.
    expect(status(null)).toContain("anonymise.remainingUnknown");
    expect(status(null)).not.toContain("anonymise.remaining#");
  });

  it("keeps the done sentence when the profile picture stays, and says so after it", () => {
    for (const remaining of [0, 2]) {
      const kept = status(remaining, { id: 5, removed: false });
      expect(kept).toContain("anonymise.done");
      expect(kept).toContain("anonymise.avatarKept");
      expect(kept.includes("anonymise.remaining")).toBe(remaining > 0);
    }
    expect(status(0, { id: 5, removed: true })).not.toContain("anonymise.avatarKept");
  });
});

describe("Enter in the document form of a create whose options failed", () => {
  const access = (roleClass: AreaAccess["roleClass"]): AreaAccess => ({
    area: "documents",
    verbs: ["create", "edit", "publish", "unpublish", "discard"],
    scope: roleClass === "moderator" ? "any" : "ownDepartment",
    roleClass,
  });
  /** Submits the form with a PDF picked (the editor's first state). */
  const submit = (roleClass: AreaAccess["roleClass"]) => {
    const tree = shallow(
      DocumentEditor,
      {
        editable: null,
        access: access(roleClass),
        timeZone: "Europe/Berlin",
        departments: [],
        optionsFailed: true,
        optionsTruncated: false,
        ownDepartment:
          roleClass === "departmentAuthor"
            ? { documentId: "deptengineering000000000", name: "Engineering" }
            : null,
      },
      [new File(["%PDF-1.7"], "policy.pdf", { type: "application/pdf" })],
    );
    const preventDefault = vi.fn();
    (find(tree, (p) => "onSubmit" in p).onSubmit as (event: object) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  };

  it("uploads and saves nothing for a moderator, whose targeting failed", () => {
    submit("moderator");
    expect(writes.upload).not.toHaveBeenCalled();
    expect(writes.save).not.toHaveBeenCalled();
  });

  it("still saves for a department author, whose department is pinned", () => {
    submit("departmentAuthor");
    expect(writes.upload).toHaveBeenCalledOnce();
  });
});

describe("the bell with an editor's unsaved changes", () => {
  const notification: Notification = {
    id: 4,
    type: "announcement",
    title: "News",
    link: "/announcements/a1",
    readAt: null,
    createdAt: "2026-10-26T09:00:00.000Z",
  };
  const select = () => {
    const tree = shallow(NotificationBell, { notifications: [notification], unreadTotal: 1 });
    const item = (p: Props) => "onSelect" in p && JSON.stringify(p.children).includes("News");
    (find(tree, item).onSelect as () => void)();
  };

  it("stays on Cancel: no navigation, no mark-read", () => {
    guard.leave = false;
    select();
    expect(router.push).not.toHaveBeenCalled();
    expect(writes.markRead).not.toHaveBeenCalled();
  });

  it("follows the link on OK", () => {
    select();
    expect(router.push).toHaveBeenCalledWith("/announcements/a1");
  });
});

describe("deleting a department with an image picked", () => {
  it("drops the pick, so the form is clean while the list is on its way", async () => {
    // The run records the control that started it (an HTMLElement check).
    vi.stubGlobal("HTMLElement", class {});
    const editable = {
      documentId: "deptdesign00000000000000",
      version: "3",
      status: "published",
      publishedAt: null,
      updatedAt: null,
      roleClass: "moderator",
      name: "Design",
      description: null,
      color: null,
      headerImage: null,
      head: null,
    } as unknown as Parameters<typeof OrgEditor>[0]["editable"];
    const banner = new File(["png"], "banner.png", { type: "image/png" });
    // States: values, initial, picked (index 2).
    const tree = shallow(OrgEditor, { type: "department", editable }, [
      undefined,
      undefined,
      banner,
    ]);
    (find(tree, (p) => p.confirmLabel === "confirm.deleteConfirm").onConfirm as () => void)();
    await Promise.allSettled(shim.transitions);
    expect(router.push).toHaveBeenCalledWith("/departments");
    expect(shim.sets).toContainEqual([2, null]);
    vi.unstubAllGlobals();
  });
});
