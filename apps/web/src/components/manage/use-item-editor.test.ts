import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveInput } from "@/lib/manage/save";
import { installFakeBrowser, type FakeBrowser } from "../live/fake-browser.test.helper";

/**
 * useItemEditor mounted in the fake browser (react-dom/client): a save
 * runs through the real useAuthoringEditor and startCmsAction against a
 * fake action, and the test reads the values and the baseline the next
 * save starts from.
 */
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => router,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("./flash", () => ({ useManageFlash: () => () => {} }));
const { useItemEditor } = await import("./use-item-editor");

interface Values {
  body: string;
  revisionSummary: string;
}
const editable = {
  documentId: "w".repeat(24),
  version: "1",
  status: "published" as const,
  publishedAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  body: "First",
};
const toValues = (source: typeof editable): Values => ({ body: source.body, revisionSummary: "" });
const empty: Values = { body: "", revisionSummary: "" };
const clearOnSave: Partial<Values> = { revisionSummary: "" };

let browser: FakeBrowser;
let editor: ReturnType<typeof useItemEditor<Values, typeof editable>>;
const save = vi.fn(async (input: SaveInput) => ({
  ok: true as const,
  data: { ...editable, version: String(Number(input.version) + 1), status: "modified" as const },
}));

function Harness({ expose }: { expose: (item: typeof editor) => void }) {
  const item = useItemEditor<Values, typeof editable>({
    area: "wiki",
    formId: "wiki-page",
    editable,
    toValues,
    emptyValues: empty,
    fieldOrder: [],
    actions: { save },
    drafts: true,
    clearOnSave,
  });
  expose(item);
  return null;
}

beforeEach(async () => {
  browser = installFakeBrowser();
  // The run records the control that started it (an HTMLElement check).
  vi.stubGlobal("HTMLElement", class {});
  save.mockClear();
  await browser.render(createElement(Harness, { expose: (item) => (editor = item) }));
});
afterEach(async () => {
  await browser.unmount();
  vi.unstubAllGlobals();
  browser.uninstall();
});

const edit = (patch: Partial<Values>) =>
  browser.act(() => {
    for (const [key, value] of Object.entries(patch)) {
      editor.setValue(key as keyof Values, value as string);
    }
  });

describe("a save's clearOnSave values (the wiki change note, v0.30)", () => {
  it("start empty again, so the same note typed for the next save is sent", async () => {
    await edit({ body: "Second", revisionSummary: "Typo" });
    await browser.act(() => editor.save("draft"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(editor.values.revisionSummary).toBe("");
    expect(editor.initial).toEqual({ body: "Second", revisionSummary: "" });

    await edit({ body: "Third", revisionSummary: "Typo" });
    await browser.act(() => editor.save("draft"));
    const second = save.mock.calls[1][0];
    // What the payload compares: the note differs from the baseline, so it is sent.
    expect(second.values).toMatchObject({ body: "Third", revisionSummary: "Typo" });
    expect(second.initial).toMatchObject({ revisionSummary: "" });
  });

  it("stay in the form when the save fails", async () => {
    save.mockResolvedValueOnce({ ok: false, code: "failed" } as never);
    await edit({ body: "Second", revisionSummary: "Typo" });
    await browser.act(() => editor.save("draft"));
    expect(editor.values.revisionSummary).toBe("Typo");
    expect(editor.dirty).toBe(true);
  });
});
