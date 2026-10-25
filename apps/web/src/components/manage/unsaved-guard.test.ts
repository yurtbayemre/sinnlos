import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeBrowser, type FakeBrowser } from "../live/fake-browser.test.helper";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const { confirmLeave, leavesPage, useUnsavedGuard } = await import("./unsaved-guard");

const HERE = "https://intranet.example.test/manage/announcements/a1?tab=2";

/** A primary click on an <a> with `attributes` (href included). */
function click(attributes: Record<string, string>, patch: Partial<MouseEvent> = {}) {
  const base = new URL(HERE);
  const anchor = {
    href: new URL(attributes.href, base).href,
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  };
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: (selector: string) => (selector === "a[href]" ? anchor : null) },
    ...patch,
  } as unknown as MouseEvent;
}

describe("leavesPage: the clicks the guard asks about", () => {
  const here = { href: HERE };

  it("asks for a same-origin link to another page or query", () => {
    expect(leavesPage(click({ href: "/manage/announcements" }), here)).toBe(true);
    expect(leavesPage(click({ href: "/manage/announcements/a1?tab=3" }), here)).toBe(true);
    expect(leavesPage(click({ href: "/news", target: "_self" }), here)).toBe(true);
  });

  it("leaves a fragment-only move (the skip link) and the same location alone", () => {
    expect(leavesPage(click({ href: "#main" }), here)).toBe(false);
    expect(leavesPage(click({ href: "/manage/announcements/a1?tab=2#top" }), here)).toBe(false);
  });

  it("leaves new tabs, downloads, other origins and handled clicks alone", () => {
    expect(leavesPage(click({ href: "/news", target: "_blank" }), here)).toBe(false);
    expect(leavesPage(click({ href: "/manage/users/7/export", download: "" }), here)).toBe(false);
    expect(leavesPage(click({ href: "https://example.org/" }), here)).toBe(false);
    for (const patch of [
      { button: 1 },
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { defaultPrevented: true },
    ]) {
      expect(leavesPage(click({ href: "/news" }, patch), here), JSON.stringify(patch)).toBe(false);
    }
    const plain = { ...click({ href: "/news" }), target: { closest: () => null } };
    expect(leavesPage(plain as unknown as MouseEvent, here)).toBe(false);
  });
});

describe("useUnsavedGuard", () => {
  let browser: FakeBrowser;
  let release: () => void;
  let navigate: ((event: object) => void) | null;
  const confirm = vi.fn(() => false);

  function Editor({ dirty }: { dirty: boolean }) {
    const done = useUnsavedGuard(dirty);
    expose(done);
    return null;
  }
  const expose = (done: () => void) => (release = done);

  beforeEach(() => {
    browser = installFakeBrowser();
    navigate = null;
    confirm.mockClear();
    Object.assign(window, {
      confirm,
      navigation: {
        addEventListener: (_type: string, listener: (event: object) => void) => {
          navigate = listener;
        },
        removeEventListener: () => {
          navigate = null;
        },
      },
    });
  });
  afterEach(async () => {
    await browser.unmount();
    browser.uninstall();
  });

  const listeners = () => ({
    click: browser.document.listenerCount("click"),
    beforeunload: (window as unknown as FakeBrowser["document"]).listenerCount("beforeunload"),
    navigate: navigate !== null,
  });

  it("asks only while the editor holds unsaved changes, and not after a save released it", async () => {
    await browser.render(createElement(Editor, { dirty: false }));
    expect(confirmLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(listeners()).toEqual({ click: 0, beforeunload: 0, navigate: false });

    await browser.render(createElement(Editor, { dirty: true }));
    expect(listeners()).toEqual({ click: 1, beforeunload: 1, navigate: true });
    expect(confirmLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("leaveUnsaved");

    release();
    expect(confirmLeave()).toBe(true);
    expect(listeners()).toEqual({ click: 0, beforeunload: 0, navigate: false });
  });

  it("does not ask again in beforeunload once the person chose to leave", async () => {
    await browser.render(createElement(Editor, { dirty: true }));
    const unload = () => {
      const event = { preventDefault: vi.fn() };
      (window as unknown as { fire(type: string, event: object): void }).fire(
        "beforeunload",
        event,
      );
      return event.preventDefault;
    };
    expect(unload()).toHaveBeenCalledOnce();
    confirm.mockReturnValueOnce(true);
    expect(confirmLeave()).toBe(true);
    expect(unload()).not.toHaveBeenCalled();
  });

  it("asks before Back or Forward and cancels the traversal on Cancel", async () => {
    await browser.render(createElement(Editor, { dirty: true }));
    const event = (navigationType: string) => ({
      navigationType,
      cancelable: true,
      preventDefault: vi.fn(),
    });
    const back = event("traverse");
    navigate?.(back);
    expect(back.preventDefault).toHaveBeenCalledOnce();

    // A push is a link or the router, which the click and confirmLeave cover.
    const push = event("push");
    navigate?.(push);
    expect(push.preventDefault).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    const ok = event("traverse");
    navigate?.(ok);
    expect(ok.preventDefault).not.toHaveBeenCalled();
  });
});
