import type { ReactElement } from "react";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";

/**
 * DeleteClassified on the shared ConfirmDialog (UI07). The props stay
 * { id, title } (lane 8A's editor takedown reuses the component), the
 * dialog gets the ad's texts, and the confirm button runs deleteClassified
 * through startCmsAction: a refusal or an outage shows a text and keeps
 * the dialog open, the success redirect (server-side, to /marketplace) is
 * rethrown and never shown as an error, and opening the dialog again
 * starts without the old error.
 *
 * As in notification-bell.test.ts, a tiny hook harness stands in for
 * React's state in Node: the component is called as a function and its
 * ConfirmDialog element's props are the handlers and the visible state.
 */
const harness = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let transitions: Promise<unknown>[] = [];
  return {
    reset() {
      slots = [];
      transitions = [];
    },
    begin() {
      cursor = 0;
    },
    /** Settles every transition the handlers started; answers their outcomes. */
    async settle() {
      const outcomes = await Promise.allSettled(transitions);
      transitions = [];
      return outcomes;
    },
    useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void] {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = initial;
      const set = (next: T | ((prev: T) => T)) => {
        slots[slot] =
          typeof next === "function" ? (next as (prev: T) => T)(slots[slot] as T) : next;
      };
      return [slots[slot] as T, set];
    },
    useTransition(): [boolean, (fn: () => Promise<void> | void) => void] {
      return [false, (fn) => void transitions.push(Promise.resolve().then(fn))];
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: harness.useState,
  useTransition: harness.useTransition,
}));

const deleteMock = vi.fn<(id: number) => Promise<ActionResult>>();
vi.mock("@/lib/classified-actions", () => ({
  deleteClassified: (id: number) => deleteMock(id),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

const { DeleteClassified } = await import("./delete-classified");
const { ConfirmDialog } = await import("@/components/ui/confirm-dialog");

type DialogProps = Parameters<typeof ConfirmDialog>[0];

/** One render: the ConfirmDialog element's props. */
function render(): DialogProps {
  harness.begin();
  const element = DeleteClassified({ id: 7, title: "Bike" }) as ReactElement<DialogProps>;
  expect(element.type).toBe(ConfirmDialog);
  return element.props;
}

function nextRedirect(): unknown {
  try {
    redirect("/marketplace");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

beforeEach(() => {
  harness.reset();
  deleteMock.mockReset();
});

describe("DeleteClassified", () => {
  it("asks with the ad's texts behind its delete button", () => {
    const dialog = render();
    expect(dialog.open).toBe(false);
    expect(dialog.title).toBe("deleteConfirmTitle");
    expect(dialog.description).toBe('deleteConfirmBody {"title":"Bike"}');
    expect(dialog.confirmLabel).toBe("delete");
    expect(dialog.pendingLabel).toBe("deleting");
    expect((dialog.trigger as ReactElement<{ type: string }>).props.type).toBe("button");
    expect(dialog.error).toBeNull();
  });

  it("opens and closes through the dialog", () => {
    render().onOpenChange(true);
    expect(render().open).toBe(true);
    render().onOpenChange(false);
    expect(render().open).toBe(false);
  });

  it.each([
    ["forbidden", "forbidden"],
    ["notFound", "notFound"],
    ["unavailable", "unavailable"],
    ["invalid", "deleteFailed"],
    ["failed", "deleteFailed"],
  ] as const)("shows %s as %s and stays open", async (code, text) => {
    deleteMock.mockResolvedValue({ ok: false, code });
    render().onOpenChange(true);
    render().onConfirm();
    await harness.settle();
    expect(deleteMock).toHaveBeenCalledWith(7);
    const dialog = render();
    expect(dialog.open).toBe(true);
    expect(dialog.error).toBe(text);
  });

  it("shows a call that never reached the server as an outage", async () => {
    deleteMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render().onConfirm();
    await harness.settle();
    expect(render().error).toBe("unavailable");
  });

  it("rethrows the success redirect instead of showing an error", async () => {
    const redirectError = nextRedirect();
    deleteMock.mockRejectedValue(redirectError);
    render().onOpenChange(true);
    render().onConfirm();
    const [outcome] = await harness.settle();
    expect(outcome).toEqual({ status: "rejected", reason: redirectError });
    expect(render().error).toBeNull();
  });

  it("starts without the old error when opened again", async () => {
    deleteMock.mockResolvedValue({ ok: false, code: "failed" });
    render().onOpenChange(true);
    render().onConfirm();
    await harness.settle();
    expect(render().error).toBe("deleteFailed");
    render().onOpenChange(false);
    render().onOpenChange(true);
    expect(render().error).toBeNull();
  });
});
