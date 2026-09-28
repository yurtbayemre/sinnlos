import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "@/lib/types";

/**
 * NotificationBell's inline mark-read error (FX28 review). A click on a
 * notification closes the panel and navigates while its mark-read is still
 * running; when that fails, the error is set with the panel closed. The
 * bell stays mounted across pages (LiveNotificationBell renders it without
 * a key), so the next opening must not show that old error. Opening the
 * panel clears it; "Mark all read" keeps its inline error, because that
 * path leaves the panel open.
 *
 * The suite runs in Node without a DOM, so a tiny hook harness stands in
 * for React's state: the component is called as a function, its returned
 * element tree is searched for the handlers, and each "render" replays the
 * hooks in call order. Only the hooks the bell uses are replaced; the
 * notification actions, the router and the translations are mocked.
 */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let transitions: Promise<unknown>[] = [];
  return {
    reset() {
      slots = [];
      transitions = [];
    },
    begin() {
      cursor = 0;
    },
    /** Settles every transition the handlers started. */
    async settle() {
      await Promise.allSettled(transitions);
      transitions = [];
    },
    useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = initial;
      const set = (next: T | ((prev: T) => T)) => {
        slots[slot] =
          typeof next === "function" ? (next as (prev: T) => T)(slots[slot] as T) : next;
      };
      return [slots[slot] as T, set];
    },
    useTransition(): [boolean, (fn: () => Promise<void> | void) => void] {
      return [false, (fn) => void transitions.push(Promise.resolve().then(fn))];
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: harness.useState,
  useTransition: harness.useTransition,
  useRef: () => ({ current: null }),
  useEffect: () => {},
}));

const markReadMock = vi.fn<(ids: number[]) => Promise<void>>();
const markAllMock = vi.fn<() => Promise<void>>();
const pushMock = vi.fn<(href: string) => void>();

vi.mock("@/lib/notification-actions", () => ({
  markNotificationsRead: (ids: number[]) => markReadMock(ids),
  markAllNotificationsRead: () => markAllMock(),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: pushMock }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const { NotificationBell } = await import("./notification-bell");

const unread: Notification = {
  id: 1,
  type: "announcement",
  title: "Sprint retro",
  link: "/announcements",
  readAt: null,
  createdAt: "2026-09-28T08:00:00.000Z",
};

type Props = Record<string, unknown> & { children?: ReactNode };

/** Every element of a rendered tree, depth first. */
function* elements(node: ReactNode): Generator<ReactElement<Props>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
  } else if (isValidElement<Props>(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}

/** One render of the bell: the handlers and what the panel shows. */
function render(notifications: Notification[] = [unread]) {
  harness.begin();
  const tree = NotificationBell({ notifications, onChanged: async () => {} });
  const all = [...elements(tree)];
  const find = (predicate: (props: Props, el: ReactElement<Props>) => boolean) =>
    all.find((el) => predicate(el.props, el));
  const click = (el: ReactElement<Props> | undefined) => {
    expect(el).toBeDefined();
    (el!.props.onClick as () => void)();
  };
  const panelOpen = all.some((el) => el.props.children === "markAllRead");
  return {
    panelOpen,
    showsError: all.some((el) => el.props.role === "alert"),
    clickBell: () => click(find((p) => String(p["aria-label"] ?? "").startsWith("title"))),
    clickNotification: () => click(find((_, el) => el.key === String(unread.id))),
    clickMarkAll: () => click(find((p) => p.children === "markAllRead")),
  };
}

beforeEach(() => {
  harness.reset();
  markReadMock.mockReset();
  markAllMock.mockReset();
  pushMock.mockReset();
});

describe("NotificationBell mark-read error", () => {
  it("does not show a failed click-through's error when the panel opens again", async () => {
    markReadMock.mockRejectedValue(new Error("cms down"));
    render().clickBell();
    render().clickNotification();
    expect(pushMock).toHaveBeenCalledWith("/announcements");
    await harness.settle();
    expect(markReadMock).toHaveBeenCalledWith([1]);
    expect(render().panelOpen).toBe(false);

    render().clickBell();
    const reopened = render();
    expect(reopened.panelOpen).toBe(true);
    expect(reopened.showsError).toBe(false);
  });

  it("keeps the inline error of a failed Mark all read while the panel stays open", async () => {
    markAllMock.mockRejectedValue(new Error("cms down"));
    render().clickBell();
    render().clickMarkAll();
    await harness.settle();
    const after = render();
    expect(after.panelOpen).toBe(true);
    expect(after.showsError).toBe(true);

    // Closing and reopening starts clean again.
    after.clickBell();
    render().clickBell();
    expect(render().showsError).toBe(false);
  });
});
