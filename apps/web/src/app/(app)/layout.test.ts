import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The signed-in app's layout states the referrer policy (v1.1, Mermaid): a literal
 * `<meta name="referrer" content="same-origin">`, the first thing it renders. It is here and
 * not in the root layout so that a page of (auth) (set-password: no-referrer) keeps its own:
 * the tag that comes later in the document wins.
 */
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => ({ mfaRestricted: false }) }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/live/live-events-provider", () => ({ LiveEventsProvider: () => null }));

const { default: AppLayout } = await import("./layout");

describe("the (app) layout", () => {
  it("sends no Referer to another origin and keeps it within this one, before anything else", async () => {
    const tree = (await AppLayout({ children: null })) as ReactElement<{ children: ReactNode }>;
    const [first] = ([] as ReactNode[]).concat(tree.props.children);
    expect(isValidElement(first)).toBe(true);
    const meta = first as ReactElement<{ name: string; content: string }>;
    expect(meta.type).toBe("meta");
    expect(meta.props).toEqual({ name: "referrer", content: "same-origin" });
  });
});
