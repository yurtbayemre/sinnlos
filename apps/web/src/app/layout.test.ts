import { describe, expect, it, vi } from "vitest";

/**
 * The root layout's viewport (issue #71): `viewport-fit=cover`, without
 * which iOS reports every env(safe-area-inset-*) as 0 and the phone tab
 * bar sits on the home indicator; the scale stays the device's. The font
 * loader, which only Next's compiler runs, is stubbed.
 */
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "font-inter" }) }));

const { viewport } = await import("./layout");

describe("the root viewport", () => {
  it("draws edge to edge at the device's width and scale", () => {
    expect(viewport).toEqual({
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
    });
  });
});
