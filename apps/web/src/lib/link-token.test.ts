import { describe, expect, it } from "vitest";
import { createLinkTokenStore } from "./link-token";

/** A window stand-in: location, history and the hashchange listeners. */
function fakeWindow(hash: string) {
  const listeners = new Set<() => void>();
  const win = {
    location: { hash, pathname: "/set-password", search: "" },
    history: {
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
        win.location.hash = String(url ?? "").includes("#") ? win.location.hash : "";
      },
    },
    addEventListener: (_type: "hashchange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "hashchange", listener: () => void) => listeners.delete(listener),
    /** A same-document navigation to a new fragment. */
    open(fragment: string) {
      win.location.hash = `#${fragment}`;
      for (const listener of listeners) listener();
    },
  };
  return win;
}

describe("the set-password link token (v0.27)", () => {
  it("takes the fragment once and scrubs it from the address bar", () => {
    const win = fakeWindow("#7.first");
    const store = createLinkTokenStore(() => win);
    expect(store.read()).toBe("7.first");
    expect(win.location.hash).toBe("");
    expect(store.read()).toBe("7.first");
  });

  it("takes a second link opened in the same document, scrubbed as well", () => {
    const win = fakeWindow("#7.first");
    const store = createLinkTokenStore(() => win);
    let changes = 0;
    const unsubscribe = store.subscribe(() => (changes += 1));
    expect(store.read()).toBe("7.first");
    win.open("8.second");
    expect(changes).toBe(1);
    expect(store.read()).toBe("8.second");
    expect(win.location.hash).toBe("");
    unsubscribe();
  });

  it("answers no token for a page opened without one", () => {
    const store = createLinkTokenStore(() => fakeWindow(""));
    expect(store.read()).toBe("");
  });
});
