import { isValidElement, type ReactElement, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
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
 *
 * Since UI02 the panel is a Radix DropdownMenu, whose elements the harness
 * does not render: the bell opens and closes through the Root's
 * onOpenChange (Radix calls it on a trigger click, Escape or an outside
 * click), "open" is the Root's `open` prop, and the menu items are
 * activated through their onSelect (Radix calls it on click, Enter or
 * Space).
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
  useId: () => "bell-note",
}));

const markReadMock = vi.fn<(ids: number[]) => Promise<ActionResult>>();
const markAllMock = vi.fn<() => Promise<ActionResult>>();
const pushMock = vi.fn<(href: string) => void>();

vi.mock("@/lib/notification-actions", () => ({
  markNotificationsRead: (ids: number[]) => markReadMock(ids),
  markAllNotificationsRead: () => markAllMock(),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: pushMock }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // relativeTime labels: the app locale and APP_TIME_ZONE come from the provider.
  useLocale: () => "en",
  useTimeZone: () => "Europe/Berlin",
}));

const { NotificationBell, nextFeed } = await import("./notification-bell");

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
function render(notifications: Notification[] = [unread], unreadTotal = 1, unavailable = false) {
  harness.begin();
  const tree = NotificationBell({
    notifications,
    unreadTotal,
    unavailable,
    onChanged: async () => {},
  });
  const all = [...elements(tree)];
  const find = (predicate: (props: Props, el: ReactElement<Props>) => boolean) =>
    all.find((el) => predicate(el.props, el));
  /** Radix's item selection: onSelect with a cancelable event. */
  const select = (el: ReactElement<Props> | undefined) => {
    expect(el).toBeDefined();
    const event = new Event("menu.itemSelect", { cancelable: true });
    (el!.props.onSelect as (event: Event) => void)(event);
    return event;
  };
  const root = find((_, el) => el.type === DropdownMenu.Root);
  const bell = find((p) => String(p["aria-label"] ?? "").startsWith("title"));
  const badge = bell
    ? [...elements(bell.props.children)].find((el) => el.type === "span")
    : undefined;
  const panelOpen = root?.props.open === true;
  const markAll = find((p) => p.children === "markAllRead");
  return {
    panelOpen,
    offersMarkAll: panelOpen && markAll !== undefined,
    badge: badge ? String(badge.props.children) : null,
    label: bell ? String(bell.props["aria-label"]) : null,
    /** The text of the element the bell's aria-describedby points at. */
    description: (() => {
      const id = bell?.props["aria-describedby"];
      if (typeof id !== "string") return null;
      return find((p) => p.id === id)?.props.children ?? null;
    })(),
    /** Texts of the panel's plain paragraphs (the notes, not the alert). */
    notes: all
      .filter((el) => el.type === "p" && el.props.role === undefined)
      .map((el) => el.props.children),
    listed: all.filter((el) => el.type === DropdownMenu.Item && el.key !== null).length,
    showsError: all.some((el) => el.props.role === "alert"),
    alertText: all.find((el) => el.props.role === "alert")?.props.children ?? null,
    /** A click on the bell: Radix toggles the menu through onOpenChange. */
    clickBell: () => {
      expect(root).toBeDefined();
      (root!.props.onOpenChange as (open: boolean) => void)(!panelOpen);
    },
    clickNotification: () => select(find((_, el) => el.key === String(unread.id))),
    clickMarkAll: () => select(markAll),
  };
}

const read = (id: number): Notification => ({ ...unread, id, readAt: "2026-09-28T09:00:00.000Z" });

describe("NotificationBell badge: the unread total (WD10)", () => {
  it("shows every unread notification, not only the unread among the 20 loaded", () => {
    const loaded = [unread, ...Array.from({ length: 19 }, (_, i) => read(i + 2))];
    const bell = render(loaded, 25);
    expect(bell.badge).toBe("25");
    expect(bell.label).toBe("title (25 unread)");
  });

  it("caps the badge at 99+ and keeps the exact count for screen readers", () => {
    const bell = render([unread], 150);
    expect(bell.badge).toBe("99+");
    expect(bell.label).toBe("title (150 unread)");
    expect(render([unread], 99).badge).toBe("99");
  });

  it("never shows fewer than the panel's own unread items", () => {
    expect(render([unread], 0).badge).toBe("1");
  });

  it("shows no badge and no Mark all read without unread notifications", () => {
    const bell = render([read(2)], 0);
    expect(bell.badge).toBeNull();
    expect(bell.label).toBe("title");
    bell.clickBell();
    const opened = render([read(2)], 0);
    expect(opened.panelOpen).toBe(true);
    expect(opened.offersMarkAll).toBe(false);
  });

  it("offers Mark all read when only older, unloaded notifications are unread", () => {
    render([read(2)], 3).clickBell();
    expect(render([read(2)], 3).offersMarkAll).toBe(true);
  });
});

beforeEach(() => {
  harness.reset();
  markReadMock.mockReset();
  markAllMock.mockReset();
  pushMock.mockReset();
});

describe("NotificationBell mark-read error", () => {
  it("does not show a failed click-through's error when the panel opens again", async () => {
    markReadMock.mockResolvedValue({ ok: false, code: "unavailable" });
    render().clickBell();
    // Not prevented: Radix closes the menu after the selection.
    expect(render().clickNotification().defaultPrevented).toBe(false);
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
    markAllMock.mockResolvedValue({ ok: false, code: "failed" });
    render().clickBell();
    // Prevented: Radix keeps the menu open after this selection.
    expect(render().clickMarkAll().defaultPrevented).toBe(true);
    await harness.settle();
    const after = render();
    expect(after.panelOpen).toBe(true);
    expect(after.showsError).toBe(true);

    // Closing and reopening starts clean again.
    after.clickBell();
    render().clickBell();
    expect(render().showsError).toBe(false);
  });

  it("names the failure: the shared text for an outage, the bell's own otherwise (AC01)", async () => {
    render().clickBell();
    markAllMock.mockResolvedValue({ ok: false, code: "failed" });
    render().clickMarkAll();
    await harness.settle();
    expect(render().alertText).toBe("markReadFailed");

    // A rejected call (the web server unreachable) is an outage.
    markAllMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render().clickMarkAll();
    await harness.settle();
    expect(render().alertText).toBe("unavailable");
  });
});

describe("NotificationBell during a cms outage (batch-12 deferral)", () => {
  const feed = { items: [unread, read(2)], unreadTotal: 4 };
  const down = { items: [], unreadTotal: 0, unavailable: true as const };

  it("keeps the last feed when a refetch comes back unavailable, and flags it", () => {
    expect(nextFeed(feed, down)).toEqual({ ...feed, unavailable: true });
  });

  it("keeps the same flagged feed while the outage lasts (no re-render)", () => {
    const flagged = nextFeed(feed, down);
    expect(nextFeed(flagged, down)).toBe(flagged);
  });

  it("replaces the feed and clears the flag with the next good answer", () => {
    const back = { items: [read(5)], unreadTotal: 0 };
    expect(nextFeed(nextFeed(feed, down), back)).toBe(back);
    expect(nextFeed(feed, back)).toBe(back);
  });

  it("keeps the empty feed, flagged, when the outage came before any feed", () => {
    expect(nextFeed({ items: [], unreadTotal: 0 }, down)).toEqual(down);
  });

  it("shows the kept list and badge with the shared outage note", () => {
    render([unread, read(2)], 4, true).clickBell();
    const bell = render([unread, read(2)], 4, true);
    expect(bell.badge).toBe("4");
    expect(bell.listed).toBe(2);
    expect(bell.notes).toEqual(["unavailable"]);
    // A screen reader hears it on the bell, before the panel opens.
    expect(bell.description).toBe("unavailable");
    expect(bell.showsError).toBe(false);
  });

  it("shows no note and no description while the cms answers", () => {
    render().clickBell();
    const bell = render();
    expect(bell.notes).toEqual([]);
    expect(bell.description).toBeNull();
  });
});
