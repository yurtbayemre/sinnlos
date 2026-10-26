import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v0.32 (#193): the bell refetches on tab regain only without a push
 * stream. With one, the stream's hello runs that catch-up (notifications
 * first) and a second fetch from the bell's own listener doubled the reads.
 * The component runs under a hook shim; its effect runs against a fake
 * document; `hello` stands for the stream's catch-up of the channel.
 */
const shim = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | void)[],
  streaming: true,
  hello: null as (() => void) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [
    typeof initial === "function" ? (initial as () => unknown)() : initial,
    () => {},
  ],
  useEffect: (effect: () => (() => void) | void) => shim.effects.push(effect),
}));
vi.mock("@/components/live/live-events-provider", () => ({
  useLiveChannel: (_channel: string, refetch: () => void) => {
    shim.hello = refetch;
    return true;
  },
  useLiveRegistry: () => ({ register: () => () => {}, healthy: true, streaming: shim.streaming }),
}));
const getNotifications = vi.hoisted(() => vi.fn(async () => ({ items: [], unreadTotal: 0 })));
vi.mock("@/lib/notification-actions", () => ({ getNotifications }));
vi.mock("./notification-bell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notification-bell")>()),
  NotificationBell: () => null,
}));

const { LiveNotificationBell } = await import("./live-notification-bell");

function fakeDocument() {
  const listeners = new Set<() => void>();
  return {
    visibilityState: "hidden" as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    /** The tab comes back. */
    show() {
      this.visibilityState = "visible";
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

/** Mounts the bell: renders it and runs its effects; the fake document and the cleanups. */
function mount(streaming: boolean) {
  shim.effects = [];
  shim.streaming = streaming;
  const doc = fakeDocument();
  vi.stubGlobal("document", doc);
  LiveNotificationBell({ initial: { items: [], unreadTotal: 0 } });
  const cleanups = shim.effects.map((effect) => effect());
  return { doc, cleanups };
}

beforeEach(() => {
  vi.useFakeTimers();
  getNotifications.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the bell on tab regain (#193)", () => {
  it("with a push stream, fetches once: the stream's hello, no listener of its own", async () => {
    const { doc, cleanups } = mount(true);
    expect(doc.listeners.size).toBe(0);
    doc.show();
    shim.hello?.(); // the reconnected stream's catch-up
    await vi.advanceTimersByTimeAsync(0);
    expect(getNotifications).toHaveBeenCalledTimes(1);
    for (const cleanup of cleanups) cleanup?.();
  });

  it("without a stream, the regain itself fetches", async () => {
    const { doc, cleanups } = mount(false);
    expect(doc.listeners.size).toBe(1);
    doc.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(getNotifications).toHaveBeenCalledTimes(1);
    for (const cleanup of cleanups) cleanup?.();
    expect(doc.listeners.size).toBe(0);
  });

  it("keeps polling either way while the tab is visible", async () => {
    const { doc, cleanups } = mount(true);
    doc.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getNotifications).toHaveBeenCalledTimes(1);
    for (const cleanup of cleanups) cleanup?.();
  });
});
