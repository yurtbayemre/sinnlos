import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The render queue of lib/mermaid-render.ts with Mermaid itself replaced: what
 * the browser would otherwise be needed for. Every render must initialize with
 * its own theme right before it draws, never two at once (the theme is global
 * state), a failed render must not stop the ones after it, and a block that is
 * gone costs no render. DOMPurify's attribute rule is registered once, before
 * the first render.
 */
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<(config: { theme: string; securityLevel: string }) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
const purify = vi.hoisted(() => ({ addHook: vi.fn<(name: string, hook: unknown) => void>() }));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("dompurify", () => ({ default: purify }));

const FLOW = "flowchart TD\n  A --> B";
const svgOf = (id: string) => `<svg id="${id}"><line id="actor0"></line></svg>`;

/** A render that stays open until `finish` (or `fail`) is called. */
function pending() {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { done, finish, fail };
}

let mod: typeof import("./mermaid-render");
let renderMermaid: typeof import("./mermaid-render").renderMermaid;
/** How many hooks were registered when Mermaid was initialized for the first time. */
let hooksAtFirstInitialize: number | undefined;
/** Mermaid's calls in order, as "initialize:<theme>" and "render:<id>". */
let calls: string[];

beforeEach(async () => {
  vi.resetModules();
  calls = [];
  hooksAtFirstInitialize = undefined;
  purify.addHook.mockReset();
  mermaid.initialize.mockReset().mockImplementation((config) => {
    hooksAtFirstInitialize ??= purify.addHook.mock.calls.length;
    calls.push(`initialize:${config.theme}`);
  });
  mermaid.render.mockReset().mockImplementation(async (id) => {
    calls.push(`render:${id}`);
    return { svg: svgOf(id) };
  });
  mod = await import("./mermaid-render");
  renderMermaid = mod.renderMermaid;
});

describe("renderMermaid", () => {
  it("registers the attribute rule with DOMPurify once, before the first render", async () => {
    await renderMermaid(FLOW, false, new AbortController().signal);
    await renderMermaid(FLOW, true, new AbortController().signal);
    await Promise.all([
      renderMermaid(FLOW, false, new AbortController().signal),
      renderMermaid(FLOW, false, new AbortController().signal),
    ]);
    expect(purify.addHook.mock.calls).toEqual([
      ["uponSanitizeAttribute", mod.dropResourceAttribute],
    ]);
    expect(hooksAtFirstInitialize).toBe(1);
  });

  it("initializes strictly with the render's own theme right before it draws", async () => {
    await renderMermaid(FLOW, false, new AbortController().signal);
    await renderMermaid(FLOW, true, new AbortController().signal);
    expect(calls).toEqual([
      "initialize:default",
      "render:sinnlosMermaid1",
      "initialize:dark",
      "render:sinnlosMermaid2",
    ]);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
    expect(mermaid.render).toHaveBeenLastCalledWith("sinnlosMermaid2", FLOW);
  });

  it("namespaces the ids of the drawn svg with the render id", async () => {
    const svg = await renderMermaid(FLOW, false, new AbortController().signal);
    expect(svg).toBe('<svg id="sinnlosMermaid1"><line id="sinnlosMermaid1-actor0"></line></svg>');
  });

  it("draws one diagram at a time: the next initializes only after the previous drew", async () => {
    const first = pending();
    mermaid.render.mockImplementationOnce(async (id) => {
      calls.push(`render:${id}`);
      await first.done;
      return { svg: svgOf(id) };
    });
    const one = renderMermaid(FLOW, false, new AbortController().signal);
    const two = renderMermaid(FLOW, true, new AbortController().signal);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    // The second has not initialized (it would switch the first one's theme).
    expect(calls).toEqual(["initialize:default", "render:sinnlosMermaid1"]);
    first.finish();
    await Promise.all([one, two]);
    expect(calls).toEqual([
      "initialize:default",
      "render:sinnlosMermaid1",
      "initialize:dark",
      "render:sinnlosMermaid2",
    ]);
  });

  it("goes on with the next diagram after one that failed", async () => {
    mermaid.render.mockRejectedValueOnce(new Error("Parse error on line 2"));
    const broken = renderMermaid("flowchart TD\n  A --> -->", false, new AbortController().signal);
    const fine = renderMermaid(FLOW, false, new AbortController().signal);
    await expect(broken).rejects.toThrow("Parse error on line 2");
    await expect(fine).resolves.toContain("<svg");
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    // ... and a later one too.
    await expect(renderMermaid(FLOW, true, new AbortController().signal)).resolves.toContain(
      "<svg",
    );
  });

  it("draws nothing for a block that is gone before its turn", async () => {
    await expect(renderMermaid(FLOW, false, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("skips one that was aborted while queued behind a running render", async () => {
    const first = pending();
    mermaid.render.mockImplementationOnce(async (id) => {
      await first.done;
      return { svg: svgOf(id) };
    });
    const gone = new AbortController();
    const one = renderMermaid(FLOW, false, new AbortController().signal);
    const two = renderMermaid(FLOW, false, gone.signal);
    const three = renderMermaid(FLOW, true, new AbortController().signal);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    gone.abort();
    first.finish();
    await expect(two).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([one, three]);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.render.mock.calls.map(([id]) => id)).toEqual([
      "sinnlosMermaid1",
      "sinnlosMermaid2",
    ]);
  });
});
