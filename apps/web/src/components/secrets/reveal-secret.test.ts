import { createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionResult } from "@/lib/action-result";
import { installFakeBrowser, type FakeBrowser } from "../live/fake-browser.test.helper";

/**
 * The reveal's client state (v0.35, plan §3.10), driven through React in
 * the fake browser: the text comes only from the click's own result; it
 * goes on `pagehide`; a result that arrives after `pagehide` or unmount is
 * dropped; and a document that ever loaded Plausible (a tab opened while
 * the module was off) reloads instead of revealing.
 */

type Reveal = ActionResult<never, { text: string }>;
const pending: ((result: Reveal) => void)[] = [];
const revealSecret = vi.fn(
  () =>
    new Promise<Reveal>((resolve) => {
      pending.push(resolve);
    }),
);
vi.mock("@/lib/secret-actions", () => ({ revealSecret: () => revealSecret() }));

const { useRevealSecret } = await import("./reveal-secret");

let browser: FakeBrowser;
let state: ReturnType<typeof useRevealSecret>;
const reload = vi.fn();
let analyticsScript = false;

/** Hands the hook's state to the test after every render. */
function Probe() {
  const value = useRevealSecret("abcdefghijklmnopqrstuvwx");
  useEffect(() => {
    state = value;
  });
  return null;
}

const win = () =>
  globalThis.window as unknown as Record<string, unknown> & {
    fire(type: string): void;
  };
/** Clicks: the reveal runs until the test answers it. */
let clicked: Promise<void> = Promise.resolve();
const click = () =>
  browser.act(() => {
    clicked = state.reveal();
  });
const answer = (text: string) =>
  browser.act(async () => {
    pending.shift()!({ ok: true, data: { text } });
    await clicked;
  });

beforeEach(async () => {
  browser = installFakeBrowser();
  Object.assign(win(), { location: { reload } });
  Object.assign(browser.document, {
    querySelector: (selector: string) =>
      selector === "script[data-domain]" && analyticsScript ? {} : null,
  });
  analyticsScript = false;
  pending.length = 0;
  revealSecret.mockClear();
  reload.mockClear();
  await browser.render(createElement(Probe));
});

afterEach(async () => {
  await browser.unmount();
  browser.uninstall();
});

describe("useRevealSecret", () => {
  it("shows the click's own result, and pagehide clears a shown text", async () => {
    expect(state.text).toBeNull();
    await click();
    expect(state.pending).toBe(true);
    await answer("s3cret");
    expect(state.text).toBe("s3cret");
    await browser.act(() => win().fire("pagehide"));
    expect(state.text).toBeNull();
  });

  it("drops a result that arrives after pagehide", async () => {
    await click();
    await browser.act(() => win().fire("pagehide"));
    await answer("late");
    expect(state.text).toBeNull();
    expect(state.pending).toBe(false);
  });

  it("drops a result that arrives after unmount", async () => {
    await click();
    const before = state;
    await browser.unmount();
    await answer("late");
    expect(state).toBe(before);
    expect(state.text).toBeNull();
    await browser.render(createElement(Probe));
    expect(state.text).toBeNull();
  });

  it("reloads instead of revealing in a document that loaded Plausible", async () => {
    win().plausible = () => undefined;
    await click();
    delete win().plausible;
    analyticsScript = true;
    await click();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(revealSecret).not.toHaveBeenCalled();
    expect(state.pending).toBe(false);
  });
});
