/**
 * A browser just big enough to mount client components with
 * react-dom/client in the Node test environment (LF05): `window`,
 * `document` (visibility and its `visibilitychange` event), `EventSource`
 * and `fetch`, installed as globals and removed again.
 *
 * The web tests run under `environment: "node"` (vitest.config.ts) and the
 * repo has no DOM library. React DOM's client renderer needs only a handful
 * of DOM members for the trees under test (context providers, components
 * that return null, a plain wrapper div): a container element, a document
 * that creates, appends and removes nodes and takes the root listeners,
 * and a `window` for the event-priority lookup. Events on elements, forms,
 * focus and layout are not modelled: a test of those needs a real DOM
 * library instead.
 *
 * Named *.test.helper.ts: not collected as a suite, and nothing outside the
 * tests imports it.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type Listener = (event: { data?: string }) => void;

/** addEventListener/removeEventListener plus a way to fire an event. */
export class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  protected fire(type: string, event: { data?: string } = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

/**
 * An EventSource the test drives: `emit` delivers a named server event,
 * `fail` is the browser's error event (readyState CLOSED: an HTTP error or
 * a redirect, the connection is gone for good; CONNECTING: a network drop
 * the browser retries itself).
 */
export class FakeEventSource extends FakeEventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  /** Every source created since the last install, oldest first. */
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }

  /** A server event; objects are sent as JSON like the stream route does. */
  emit(type: string, data: unknown = ""): void {
    this.readyState = FakeEventSource.OPEN;
    this.fire(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** The browser's error event with the given readyState. */
  fail(readyState: number = FakeEventSource.CLOSED): void {
    this.readyState = readyState;
    this.onerror?.({});
  }

  /** The newest source, which must exist. */
  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("no EventSource was created");
    return source;
  }

  /** The sources that are not closed. */
  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((source) => !source.closed);
  }
}

/** One recorded fetch call with its JSON body. */
export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * The element and text nodes React DOM creates, appends and removes for
 * plain host elements (a wrapper div); no layout, events or properties
 * beyond attributes.
 */
class FakeNode extends FakeEventTarget {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  onclick: unknown = null;

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument | null,
  ) {
    super();
  }

  get tagName(): string {
    return this.nodeName;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  set textContent(_value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument extends FakeEventTarget {
  readonly nodeType = 9;
  readonly activeElement = null;
  readonly body = null;
  defaultView: unknown = null;
  visibilityState: DocumentVisibilityState = "visible";

  createElement(tag: string): FakeNode {
    return new FakeNode(1, tag.toUpperCase(), this);
  }

  createTextNode(text: string): FakeNode {
    return Object.assign(new FakeNode(3, "#text", this), { nodeValue: text });
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.fire("visibilitychange");
  }
}

export interface FakeBrowser {
  document: FakeDocument;
  /** Every fetch call since the install (or the last `calls.length = 0`). */
  calls: FetchCall[];
  /** Renders `element` into the one root (mounting it first) inside act(). */
  render(element: ReactElement): Promise<void>;
  /** Unmounts the root inside act(). */
  unmount(): Promise<void>;
  /** Runs `fn` inside act() and flushes effects and microtasks. */
  act(fn: () => void | Promise<void>): Promise<void>;
  /** Hides or shows the tab (fires visibilitychange) inside act(). */
  setVisibility(state: DocumentVisibilityState): Promise<void>;
  /** Removes the globals again. */
  uninstall(): void;
}

const GLOBALS = ["window", "document", "EventSource", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

/**
 * Installs the fake browser as globals. `fetchImpl` answers every fetch
 * (default: 200 `{ ok: true }`); each call is recorded in `calls`.
 */
export function installFakeBrowser(
  fetchImpl: (call: FetchCall) => Promise<Response> = async () => Response.json({ ok: true }),
): FakeBrowser {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map(GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(g, key)]));
  const document = new FakeDocument();
  const window = Object.assign(new FakeEventTarget(), {
    document,
    event: undefined,
    HTMLIFrameElement: class {},
  });
  document.defaultView = window;
  const calls: FetchCall[] = [];
  FakeEventSource.instances = [];

  const install = (key: (typeof GLOBALS)[number], value: unknown) =>
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  install("window", window);
  install("document", document);
  install("EventSource", FakeEventSource);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("fetch", async (input: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return fetchImpl(call);
  });

  const container = document.createElement("div");
  let root: Root | null = null;

  const inAct = async (fn: () => void | Promise<void>) => {
    await act(async () => {
      await fn();
    });
  };

  return {
    document,
    calls,
    act: inAct,
    async render(element) {
      root ??= createRoot(container as unknown as Element);
      const current = root;
      await inAct(() => current.render(element));
    },
    async unmount() {
      await inAct(() => root?.unmount());
      root = null;
    },
    setVisibility: (state) => inAct(() => document.setVisibility(state)),
    uninstall() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(g, key, descriptor);
        else delete g[key];
      }
    },
  };
}
