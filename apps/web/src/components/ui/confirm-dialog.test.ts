import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { CONFIRM_TONE_CLASS, ConfirmDialog, ModalDialog } from "./confirm-dialog";

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

describe("ConfirmDialog tone (batch 15, decision 06 §L5)", () => {
  it("keeps the destructive red as the default, so the existing callers are unchanged", () => {
    expect(CONFIRM_TONE_CLASS.destructive).toContain("bg-destructive");
    expect(CONFIRM_TONE_CLASS.destructive).toContain("text-destructive-foreground");
  });

  it("gives a question that destroys nothing the primary colour", () => {
    expect(CONFIRM_TONE_CLASS.default).toContain("bg-primary");
    expect(CONFIRM_TONE_CLASS.default).not.toContain("destructive");
  });

  it("renders the closed trigger the same with either tone", () => {
    const props = {
      open: false,
      onOpenChange: vi.fn(),
      trigger,
      title: "Publish?",
      confirmLabel: "Publish",
      onConfirm: vi.fn(),
    };
    expect(render(createElement(ConfirmDialog, { ...props, tone: "default" }))).toBe(
      render(createElement(ConfirmDialog, props)),
    );
  });
});
