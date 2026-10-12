import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { ConfirmDialog, ModalDialog } from "./confirm-dialog";

/**
 * The Radix-based dialogs (UI07), server-rendered. The trigger is Radix's
 * Dialog.Trigger (focus returns to it on close, it announces the dialog it
 * opens); the dialog itself is portaled on the client only, so nothing of
 * it — not even when open — is part of the server markup. The focus trap,
 * Escape and focus return are Radix's and are exercised in the browser
 * rehearsal.
 */
const render = (element: ReactElement) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Berlin",
      children: element,
    }),
  );

const trigger = createElement("button", { type: "button" }, "Delete ad");

describe("ConfirmDialog / ModalDialog on the server", () => {
  it("renders the closed trigger as a dialog trigger", () => {
    const html = render(
      createElement(ConfirmDialog, {
        open: false,
        onOpenChange: vi.fn(),
        trigger,
        title: "Delete this ad?",
        description: "Gone for good.",
        confirmLabel: "Delete",
        onConfirm: vi.fn(),
      }),
    );
    const tag = /<button[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain('aria-haspopup="dialog"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('data-state="closed"');
    expect(html).toContain(">Delete ad</button>");
    expect(html).not.toContain("Delete this ad?");
  });

  it("puts nothing of an open dialog into the server markup (client portal)", () => {
    const html = render(
      createElement(ModalDialog, { open: true, onOpenChange: vi.fn(), title: "Give kudos" }),
    );
    expect(html).toBe("");
  });
});
