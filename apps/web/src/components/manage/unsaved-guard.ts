"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

/**
 * Unsaved changes in a /manage editor (v0.30): one guard for every way out
 * of the page, so a click elsewhere never drops what the form holds.
 *
 *  - Closing or reloading the tab: `beforeunload`, the browser's own prompt.
 *  - A same-origin link (Next's Link renders an <a>): a capture-phase click
 *    listener on the document runs before Link's own handler, which checks
 *    `defaultPrevented` before it navigates. Modified and non-primary
 *    clicks, `download`, a `target` other than _self and links to the same
 *    location (identical path and query; a fragment-only move such as the
 *    #main skip link) are left alone.
 *  - Programmatic moves of the shell (search, the bell) and sign-out call
 *    `confirmLeave()` first.
 *  - Browser Back/Forward: where the Navigation API exists, a `navigate`
 *    event of type traverse that is cancellable asks, and Cancel prevents
 *    it without touching the history state. Elsewhere Back/Forward leave
 *    without asking: the App Router offers no cancellable traversal, and a
 *    history sentinel would fight Next's own history entries. An accepted
 *    limit.
 *
 * A save or delete releases the guard before its own navigation.
 */

/** Each dirty editor's prompt, in its own locale; the newest one asks. */
const dirtyEditors = new Map<symbol, string>();
// The person chose to leave: a document navigation that follows (a plain
// link, a hard redirect) does not ask a second time in `beforeunload`.
// Until the next key or pointer press on the page: a departure that did
// not happen (Back to a fragment, a failed request) asks again after it.
let leaving = false;

/** Asks before leaving while an editor holds unsaved changes; true = leave. */
export function confirmLeave(): boolean {
  if (dirtyEditors.size === 0) return true;
  leaving = window.confirm([...dirtyEditors.values()].at(-1)!);
  return leaving;
}

interface ClickLike {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

interface AnchorLike {
  href: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/** Whether a click is an in-app navigation the guard must ask about. */
export function leavesPage(event: ClickLike, location: { href: string }): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  const anchor = (target?.closest?.("a[href]") ?? null) as AnchorLike | null;
  if (!anchor || anchor.hasAttribute("download")) return false;
  const frame = anchor.getAttribute("target");
  if (frame && frame !== "_self") return false;
  const here = new URL(location.href);
  const there = new URL(anchor.href, here);
  if (there.origin !== here.origin) return false;
  return there.pathname !== here.pathname || there.search !== here.search;
}

function onClick(event: Event) {
  if (leavesPage(event as MouseEvent, window.location) && !confirmLeave()) event.preventDefault();
}

interface NavigateLike {
  navigationType: string;
  cancelable: boolean;
  preventDefault(): void;
}

function onNavigate(event: NavigateLike) {
  if (event.navigationType === "traverse" && event.cancelable && !confirmLeave()) {
    event.preventDefault();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (!leaving) event.preventDefault();
}

function onPress() {
  leaving = false;
}

type NavigationLike = {
  addEventListener(type: "navigate", listener: (event: NavigateLike) => void): void;
  removeEventListener(type: "navigate", listener: (event: NavigateLike) => void): void;
};

function navigationApi(): NavigationLike | undefined {
  return (window as unknown as { navigation?: NavigationLike }).navigation;
}

function listen(on: boolean) {
  const method = on ? "addEventListener" : "removeEventListener";
  leaving = false;
  window[method]("beforeunload", onBeforeUnload);
  document[method]("click", onClick, true);
  document[method]("keydown", onPress, true);
  document[method]("pointerdown", onPress, true);
  navigationApi()?.[method]("navigate", onNavigate);
}

/**
 * Registers an editor's unsaved state. Returns `release`, which a save or
 * delete calls right before it navigates away on success.
 */
export function useUnsavedGuard(dirty: boolean): () => void {
  const t = useTranslations("manage.common.editor");
  const token = useRef(Symbol("editor"));
  const text = t("leaveUnsaved");

  const release = useCallback(() => {
    if (dirtyEditors.delete(token.current) && dirtyEditors.size === 0) listen(false);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const self = token.current;
    if (dirtyEditors.size === 0) listen(true);
    dirtyEditors.set(self, text);
    return () => {
      if (dirtyEditors.delete(self) && dirtyEditors.size === 0) listen(false);
    };
  }, [dirty, text]);

  return release;
}
