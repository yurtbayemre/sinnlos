import { isValidElement, type ReactElement } from "react";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectMenu } from "@/components/ui/select-menu";

/**
 * LocaleSwitcher (UI02): the language pick runs switchLocale inside a
 * transition, and while it runs the trigger is `busy`, never `disabled`
 * (8B fix round). The pending state commits before the menu closes, and
 * Radix's focus return does nothing on a disabled button: a keyboard user
 * who picked a language lost the focus to <body>. A second pick while one
 * switch runs is ignored instead.
 *
 * The suite runs in Node without a DOM: the component is called as a
 * function with useTransition replaced (pending or not, the started
 * transitions collected), and the SelectMenu element it returns is read.
 */
const harness = vi.hoisted(() => ({
  pending: false,
  transitions: [] as Promise<unknown>[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useTransition: (): [boolean, (fn: () => Promise<void> | void) => void] => [
    harness.pending,
    (fn) => void harness.transitions.push(Promise.resolve().then(fn)),
  ],
}));

const switchLocaleMock = vi.fn<(locale: string) => Promise<void>>();
vi.mock("@/lib/locale-actions", () => ({
  switchLocale: (locale: string) => switchLocaleMock(locale),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const { LocaleSwitcher } = await import("./locale-switcher");

type MenuProps = Parameters<typeof SelectMenu>[0];

/** The SelectMenu the switcher renders, with its props. */
function render(): MenuProps {
  const element: unknown = LocaleSwitcher();
  expect(isValidElement(element)).toBe(true);
  const menu = element as ReactElement<MenuProps>;
  expect(menu.type).toBe(SelectMenu);
  return menu.props;
}

beforeEach(() => {
  harness.pending = false;
  harness.transitions = [];
  switchLocaleMock.mockReset();
  switchLocaleMock.mockResolvedValue(undefined);
});

describe("LocaleSwitcher", () => {
  it("offers both languages and shows the current one on an idle, enabled trigger", () => {
    const menu = render();
    expect(menu.value).toBe("en");
    expect(menu.options.map((o) => o.value)).toEqual(["de", "en"]);
    expect(menu.busy).toBe(false);
    expect(menu.disabled).toBeFalsy();
  });

  it("switches to the picked language inside a transition", async () => {
    render().onChange("de");
    expect(harness.transitions).toHaveLength(1);
    await Promise.all(harness.transitions);
    expect(switchLocaleMock).toHaveBeenCalledWith("de");
  });

  it("ignores the current language and unknown values", () => {
    render().onChange("en");
    render().onChange("fr");
    expect(harness.transitions).toHaveLength(0);
  });

  it("keeps the trigger enabled but busy while a switch runs (focus return)", () => {
    harness.pending = true;
    const menu = render();
    expect(menu.busy).toBe(true);
    // Disabled, the trigger could not take the focus back from the menu.
    expect(menu.disabled).toBeFalsy();
  });

  it("ignores another pick while a switch runs", () => {
    harness.pending = true;
    render().onChange("de");
    expect(harness.transitions).toHaveLength(0);
    expect(switchLocaleMock).not.toHaveBeenCalled();
  });

  it("keeps the current language when the call fails, and rethrows Next's redirect", async () => {
    switchLocaleMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render().onChange("de");
    await expect(harness.transitions[0]).resolves.toBeUndefined();

    let redirectError: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      redirectError = error;
    }
    switchLocaleMock.mockRejectedValueOnce(redirectError);
    render().onChange("de");
    await expect(harness.transitions[1]).rejects.toBe(redirectError);
  });
});
