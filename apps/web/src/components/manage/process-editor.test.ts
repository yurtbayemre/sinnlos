import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { NEW_PROCESS_DIAGRAM } from "@/lib/process-diagram";

/**
 * The process editor's own logic (v1.1 "Tools"), driven through its handlers like the duty
 * editor (duty-plan-editor.test.ts): the component is called as a function under a shallow
 * hook shim that numbers its useState calls, so a test can hand it the modeler's API. What is
 * pinned: an import checks the size BEFORE it reads the file and refuses what the cms would
 * refuse; a save asks the modeler for the latest XML and sends it as the diagram, an
 * untouched diagram is not sent again.
 */
const hooks = vi.hoisted(() => ({
  call: 0,
  /** useState call number → value (the others keep their initial value). */
  state: {} as Record<number, unknown>,
  setters: {} as Record<number, ReturnType<typeof vi.fn>>,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.call++;
    hooks.setters[index] ??= vi.fn();
    return [index in hooks.state ? hooks.state[index] : initial, hooks.setters[index]];
  },
  useMemo: (make: () => unknown) => make(),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/manage/process-actions", () => ({
  saveProcess: vi.fn(),
  publishProcess: vi.fn(),
  unpublishProcess: vi.fn(),
  discardProcess: vi.fn(),
  deleteProcess: vi.fn(),
}));
vi.mock("@/components/processes/diagram-modeler-lazy", () => ({ DiagramModelerLazy: () => null }));
vi.mock("./editor-chrome", () => ({
  ConflictDialog: () => null,
  EditorStatus: () => null,
  FormAlert: () => null,
  useFieldError: () => () => undefined,
}));
vi.mock("./publish-bar", () => ({ draftSubmit: () => () => {}, PublishBar: () => null }));
const item = vi.hoisted(() => ({
  values: null as unknown,
  setValue: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./use-item-editor", () => ({
  useItemEditor: () => ({
    values: item.values,
    setValue: item.setValue,
    save: item.save,
    dirty: false,
    handlers: { saveDraft: () => {}, saveAndPublish: () => {}, publish: () => {} },
    reload: () => {},
    editor: { fieldErrors: {}, pending: false, meta: null, failure: null },
  }),
}));

const { ProcessEditor } = await import("./process-editor");

type Props = Record<string, unknown> & { children?: ReactNode };

function find(node: ReactNode, match: (props: Props) => boolean): Props {
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) queue.unshift(...next);
    else if (isValidElement(next)) {
      const props = (next as ReactElement<Props>).props;
      if (match(props)) return props;
      queue.unshift(props.children);
    }
  }
  throw new Error("no such element");
}

/** useState call numbers of ProcessEditor, in order. */
const MODELER = 2;
const NOTE = 4;

const access: AreaAccess = {
  area: "processes",
  verbs: ["create", "edit", "publish", "unpublish", "discard"],
  scope: "ownDepartment",
  roleClass: "departmentAuthor",
};
const STORED = NEW_PROCESS_DIAGRAM;

function render() {
  hooks.call = 0;
  return ProcessEditor({
    editable: { documentId: "k3m9x0000000000000000001" } as ProcessEditable,
    access,
    departments: [],
    optionsFailed: false,
    optionsTruncated: false,
    ownDepartment: { documentId: "dept", name: "Engineering" },
  });
}

/** The import input's change handler. */
function importer(tree: ReactNode) {
  const field = find(tree, (props) => props.id === "process-import");
  // The Field's children is a render callback (a11y attributes in, the control out).
  const control = field.children as unknown as (a11y: { id: string }) => ReactElement<Props>;
  const input = control({ id: "process-import" });
  return input.props.onChange as (event: {
    currentTarget: { files: unknown[]; value: string };
  }) => void;
}

const fileOf = (text: string, size = text.length) => ({
  size,
  text: vi.fn(async () => text),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hooks.state = {};
  hooks.setters = {};
  item.values = { title: "T", summary: "S", department: "dept", diagram: STORED };
  item.setValue.mockReset();
  item.save.mockReset();
});

describe("the diagram import", () => {
  it("refuses a file above 700 KiB without reading it", async () => {
    const file = fileOf("never read", 700 * 1024 + 1);
    importer(render())({ currentTarget: { files: [file], value: "x" } });
    await settle();
    expect(file.text).not.toHaveBeenCalled();
    expect(hooks.setters[NOTE]).toHaveBeenCalledWith({ kind: "error", key: "importTooLarge" });
  });

  it("refuses what the cms would refuse: no BPMN, a DOCTYPE, a url() paint, and loads nothing", async () => {
    const load = vi.fn(async () => "xml");
    hooks.state[MODELER] = { save: vi.fn(), load };
    const hostile = NEW_PROCESS_DIAGRAM.replace(
      "<bpmndi:BPMNShape ",
      '<bpmndi:BPMNShape bioc:stroke="url(http://evil.example/x)" ',
    );
    for (const text of ["<html/>", `<!DOCTYPE x>${NEW_PROCESS_DIAGRAM}`, hostile]) {
      hooks.setters = {};
      importer(render())({ currentTarget: { files: [fileOf(text)], value: "x" } });
      await settle();
      expect(hooks.setters[NOTE], text.slice(0, 30)).toHaveBeenCalledWith({
        kind: "error",
        key: "importInvalid",
      });
    }
    expect(load).not.toHaveBeenCalled();
    expect(item.setValue).not.toHaveBeenCalled();
  });

  it("loads a clean file into the modeler and keeps the modeler's own XML as the value", async () => {
    const load = vi.fn(async () => "<formatted/>");
    hooks.state[MODELER] = { save: vi.fn(), load };
    const input = { files: [fileOf(NEW_PROCESS_DIAGRAM)], value: "x" };
    importer(render())({ currentTarget: input });
    await settle();
    expect(load).toHaveBeenCalledWith(NEW_PROCESS_DIAGRAM);
    expect(item.setValue).toHaveBeenCalledWith("diagram", "<formatted/>");
    expect(hooks.setters[NOTE]).toHaveBeenCalledWith({ kind: "ok", key: "imported" });
    // The input is cleared, so the same file can be chosen again.
    expect(input.value).toBe("");
  });

  it("says so when the modeler cannot read a file that passed the rules", async () => {
    hooks.state[MODELER] = {
      save: vi.fn(),
      load: vi.fn(async () => {
        throw new Error("parse error");
      }),
    };
    importer(render())({ currentTarget: { files: [fileOf(NEW_PROCESS_DIAGRAM)], value: "x" } });
    await settle();
    expect(item.setValue).not.toHaveBeenCalled();
    expect(hooks.setters[NOTE]).toHaveBeenCalledWith({ kind: "error", key: "importInvalid" });
  });
});

describe("a save", () => {
  const handlersOf = (tree: ReactNode) =>
    find(tree, (props) => "handlers" in props && "verbs" in props).handlers as {
      saveDraft(): void;
      saveAndPublish(): void;
    };

  it("sends the modeler's latest XML as the diagram", async () => {
    hooks.state[MODELER] = { save: vi.fn(async () => "<edited/>"), load: vi.fn() };
    handlersOf(render()).saveDraft();
    await settle();
    expect(item.setValue).toHaveBeenCalledWith("diagram", "<edited/>");
    expect(item.save).toHaveBeenCalledWith("draft", undefined, { diagram: "<edited/>" });
  });

  it("saves as published the same way", async () => {
    hooks.state[MODELER] = { save: vi.fn(async () => "<edited/>"), load: vi.fn() };
    handlersOf(render()).saveAndPublish();
    await settle();
    expect(item.save).toHaveBeenCalledWith("published", undefined, { diagram: "<edited/>" });
  });

  it("leaves the diagram alone when the author did not edit it, or it already is the value", async () => {
    for (const saved of [null, STORED]) {
      item.save.mockReset();
      hooks.state[MODELER] = { save: vi.fn(async () => saved), load: vi.fn() };
      handlersOf(render()).saveDraft();
      await settle();
      expect(item.save).toHaveBeenCalledWith("draft");
    }
    expect(item.setValue).not.toHaveBeenCalled();
  });

  it("saves without a modeler (not loaded yet) as the form stands", async () => {
    handlersOf(render()).saveDraft();
    await settle();
    expect(item.save).toHaveBeenCalledWith("draft");
  });
});
