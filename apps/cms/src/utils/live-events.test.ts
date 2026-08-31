import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __flushLiveEventsForTest, emitLiveEvent } from "./live-events";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
  process.env.WEB_INTERNAL_URL = "http://web:3000";
  process.env.REVALIDATE_SECRET = "test-secret";
  delete process.env.LIVE_EVENTS_DISABLED;
});

afterEach(async () => {
  await __flushLiveEventsForTest();
  vi.unstubAllGlobals();
});

describe("emitLiveEvent batching", () => {
  it("collapses a burst into ONE POST and dedupes per channel", async () => {
    // The announcement fan-out shape: one announcements ping + N
    // notification rows + repeated pings for the same comment channel.
    emitLiveEvent({ kind: "announcements" });
    emitLiveEvent({ kind: "notification", recipientId: 1 });
    emitLiveEvent({ kind: "notification", recipientId: 2 });
    emitLiveEvent({ kind: "notification", recipientId: 1 }); // dupe
    emitLiveEvent({ kind: "content", targetType: "announcement", targetDocumentId: "abc" });
    emitLiveEvent({ kind: "content", targetType: "announcement", targetDocumentId: "abc" }); // dupe

    await __flushLiveEventsForTest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://web:3000/api/live/emit");
    expect(init.headers["x-revalidate-secret"]).toBe("test-secret");
    const { events } = JSON.parse(init.body);
    expect(events).toHaveLength(4);
  });

  it("no-ops when WEB_INTERNAL_URL is unset (local dev)", async () => {
    delete process.env.WEB_INTERNAL_URL;
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when the kill switch is on", async () => {
    process.env.LIVE_EVENTS_DISABLED = "1";
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns on non-2xx instead of failing silently", async () => {
    // The proxy.ts-307 failure class: a misroute must be VISIBLE in the
    // cms logs, unlike revalidate.ts which swallows non-2xx.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 307 });
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status=307"));
    warn.mockRestore();
  });

  it("never throws when the web container is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitLiveEvent({ kind: "notification", recipientId: 1 });
    await expect(__flushLiveEventsForTest()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    warn.mockRestore();
  });
});
