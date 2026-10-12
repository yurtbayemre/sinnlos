import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu } from "./select-menu";

/**
 * SelectMenu on Radix DropdownMenu (UI02), server-rendered: the contract
 * classified-form and people-grid rely on stays — the hidden input carries
 * the value into the form's FormData (only with `name`), the trigger shows
 * the current option — and the trigger's accessible name is the label plus
 * the current option's full label. The open menu is portaled on the client
 * and never part of the server markup.
 */
const OPTIONS = [
  { value: "sale", label: "For sale" },
  { value: "wanted", label: "Wanted", short: "W" },
];

const render = (props: Partial<Parameters<typeof SelectMenu>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SelectMenu, {
      value: "sale",
      onChange: vi.fn(),
      options: OPTIONS,
      ariaLabel: "Category",
      ...props,
    }),
  );

/** The text of the element with `id` in `html`. */
function textOf(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`id="${escaped}"[^>]*>([^<]*)<`).exec(html);
  return match ? match[1] : null;
}

describe("SelectMenu", () => {
  it("puts the value into the form through a hidden input when named", () => {
    const html = render({ name: "category", value: "wanted" });
    expect(html).toMatch(/<input type="hidden" name="category" value="wanted"\/>/);
  });

  it("renders no input without a name (a filter, not a form field)", () => {
    expect(render()).not.toContain("<input");
  });

  it("shows the current option in a closed menu button", () => {
    const html = render();
    const trigger = /<button[^>]*>/.exec(html)?.[0] ?? "";
    expect(trigger).toContain('type="button"');
    expect(trigger).toContain('aria-haspopup="menu"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('data-state="closed"');
    expect(html).toContain(">For sale</span>");
    // The options live in the client-side portal only.
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("menuitemradio");
  });

  it("names the trigger by its label and the current option's full label", () => {
    const html = render({ value: "wanted" });
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1] ?? "";
    const ids = labelledBy.split(" ");
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => textOf(html, id))).toEqual(["Category", "Wanted"]);
    // The closed trigger shows the short text.
    expect(html).toContain(">W</span>");
  });

  it("disables the trigger on request", () => {
    const trigger = /<button[^>]*>/.exec(render({ disabled: true }))?.[0] ?? "";
    expect(trigger).toMatch(/\sdisabled=""/);
  });

  it("marks a busy trigger with aria-busy and keeps it enabled (focus can return to it)", () => {
    const busy = /<button[^>]*>/.exec(render({ busy: true }))?.[0] ?? "";
    expect(busy).toContain('aria-busy="true"');
    expect(busy).not.toMatch(/\sdisabled=""/);
    const idle = /<button[^>]*>/.exec(render())?.[0] ?? "";
    expect(idle).not.toMatch(/\saria-busy=/);
  });
});
