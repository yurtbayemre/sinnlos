/**
 * The token of a set-password mail link (v0.27): it lives in the URL
 * fragment, so the browser never sends it to a server on its own. This
 * store takes it once per link and scrubs it from the address bar and the
 * history entry right away; a later link opened in the same document (a
 * hashchange) replaces it. A useSyncExternalStore source (server: null).
 */
type LinkWindow = {
  location: Pick<Location, "hash" | "pathname" | "search">;
  history: Pick<History, "replaceState">;
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
};

export function createLinkTokenStore(win: () => LinkWindow) {
  let token: string | undefined;
  const capture = () => {
    const w = win();
    const fragment = w.location.hash.slice(1);
    if (fragment) {
      token = fragment;
      w.history.replaceState(null, "", w.location.pathname + w.location.search);
    } else if (token === undefined) {
      token = "";
    }
  };
  return {
    subscribe(onChange: () => void) {
      const handler = () => {
        capture();
        onChange();
      };
      const w = win();
      w.addEventListener("hashchange", handler);
      return () => w.removeEventListener("hashchange", handler);
    },
    read(): string {
      if (token === undefined) capture();
      return token ?? "";
    },
  };
}

export const linkTokenStore = createLinkTokenStore(() => window);
