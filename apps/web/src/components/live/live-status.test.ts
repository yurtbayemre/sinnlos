import { createElement, useEffect, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { FakeEventSource, installFakeBrowser, type FakeBrowser } from "./fake-browser.test.helper";
import { LiveEventsProvider } from "./live-events-provider";
import { DEGRADED_NOTICE_DELAY_MS, LiveStatusView, useDegradedNotice } from "./live-status";

/**
 * The header's "live updates delayed" note (batch 13 merge, 8C-T01): shown
 * once the stream has been unhealthy for DEGRADED_NOTICE_DELAY_MS in a
 * visible tab, hidden at once by a fresh heartbeat, never without a stream.
 * The hook runs under the real LiveEventsProvider with a fake EventSource
 * and fake timers (fake-browser.test.helper.ts); the markup renders with
 * the real catalogs.
 */

describe("LiveStatusView", () => {
  function render(degraded: boolean, locale: "en" | "de" = "en", newVersion = false): string {
    return renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "en" ? en : de,
        timeZone: "Europe/Berlin",
        children: createElement(LiveStatusView, { degraded, newVersion }),
      }),
    );
  }

  it.each([
    ["en", en],
    ["de", de],
  ] as const)(
    "offers a reload after a deploy in %s, in place of the delayed note (#214)",
    (locale, messages) => {
      const html = render(true, locale, true);
      expect(html).toContain('role="status"');
      expect(html).toContain('<button type="button"');
      expect(html).toContain(`title="${messages.live.newVersionHint}"`);
      // The label is the button's name at every width, visible from xl.
      expect(html).toContain(
        `<span class="sr-only xl:not-sr-only xl:whitespace-nowrap">${messages.live.newVersion}</span>`,
      );
      expect(html).not.toContain(messages.live.delayed);
    },
  );

  it("renders an empty polite status region while the stream is fine", () => {
    expect(render(false)).toBe(
      '<div role="status" aria-live="polite" class="flex items-center"></div>',
    );
  });

  it.each([
    ["en", en],
    ["de", de],
  ] as const)("names the delay in %s, with the hint as the tooltip", (locale, messages) => {
    const html = render(true, locale);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(`>${messages.live.delayed}</span>`);
    expect(html).toContain(`title="${messages.live.delayedHint}"`);
    // The icon is decoration; the label is read out at every width.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('class="sr-only xl:not-sr-only xl:whitespace-nowrap"');
  });
});

describe("useDegradedNotice", () => {
  let browser: FakeBrowser;
  let shown: boolean[] = [];

  /** Records the hook's value after every render. */
  function Probe() {
    const value = useDegradedNotice();
    useEffect(() => {
      shown.push(value);
    }, [value]);
    return null;
  }

  async function mount(enabled = true) {
    await browser.render(
      // eslint-disable-next-line react/no-children-prop -- as above
      createElement(LiveEventsProvider, {
        enabled,
        children: createElement(Probe) as ReactElement,
      }),
    );
  }

  const advance = (ms: number) => browser.act(() => vi.advanceTimersByTimeAsync(ms).then(() => {}));
  const emit = (type: string, data: unknown) =>
    browser.act(() => FakeEventSource.latest().emit(type, data));
  const now = () => shown.at(-1);

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    browser = installFakeBrowser(async () => Response.json({}));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await browser.unmount();
    browser.uninstall();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stays hidden on a page load whose hello comes in time", async () => {
    await mount();
    await advance(DEGRADED_NOTICE_DELAY_MS - 1_000);
    await emit("hello", { connId: "conn-1", emitFresh: true });
    await advance(10 * DEGRADED_NOTICE_DELAY_MS);
    expect(shown).toEqual([false]);
  });

  it("shows after the delay when the cms leg goes stale, and hides on a fresh heartbeat", async () => {
    await mount();
    await emit("hello", { connId: "conn-1", emitFresh: true });
    await emit("hb", { emitFresh: false });
    await advance(DEGRADED_NOTICE_DELAY_MS - 1);
    expect(now()).toBe(false);
    await advance(1);
    expect(now()).toBe(true);
    await emit("hb", { emitFresh: true });
    expect(now()).toBe(false);
    // The next stale heartbeat waits the full delay again.
    await emit("hb", { emitFresh: false });
    await advance(DEGRADED_NOTICE_DELAY_MS - 1);
    expect(now()).toBe(false);
    await advance(1);
    expect(now()).toBe(true);
  });

  it("shows when the cms was already stale at page load", async () => {
    await mount();
    await emit("hello", { connId: "conn-1", emitFresh: false });
    await advance(DEGRADED_NOTICE_DELAY_MS);
    expect(now()).toBe(true);
  });

  it("never shows without a stream (LIVE_EVENTS_DISABLED, DEMO_MODE)", async () => {
    await mount(false);
    await advance(10 * 60_000);
    expect(shown).toEqual([false]);
  });

  it("stays hidden in a hidden tab and while a regained tab reconnects", async () => {
    await mount();
    await emit("hello", { connId: "conn-1", emitFresh: true });
    await browser.setVisibility("hidden");
    await advance(10 * 60_000);
    expect(now()).toBe(false);
    await browser.setVisibility("visible");
    await advance(1_000);
    await emit("hello", { connId: "conn-2", emitFresh: true });
    await advance(10 * DEGRADED_NOTICE_DELAY_MS);
    expect(shown.every((value) => !value)).toBe(true);
  });
});
