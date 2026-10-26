import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_KUDOS_MESSAGE } from "@sinnlos/domain";

/**
 * v0.32 (#182, #198), the kudos dialog under a shallow hook shim (as in
 * components/manage/shallow-handlers.test.ts): the component is called as
 * a function, every state update is recorded, and the transition's pending
 * flag is set by the test. While a send is pending, one disabled fieldset
 * holds every draft control (recipient, values, message), so nothing typed
 * then can be cleared unsent by the success; a failure leaves the draft.
 */
const shim = vi.hoisted(() => ({
  index: 0,
  seed: new Map<number, unknown>(),
  sets: [] as [number, unknown][],
  pending: false,
  transitions: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = shim.index++;
    return [
      shim.seed.has(index) ? shim.seed.get(index) : initial,
      (next: unknown) => shim.sets.push([index, next]),
    ];
  },
  useTransition: () => [shim.pending, (run: () => unknown) => shim.transitions.push(run())],
  useMemo: (make: () => unknown) => make(),
  useRef: (current: unknown) => ({ current }),
  useId: () => "id",
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const send = vi.hoisted(() => ({ result: { ok: true } as unknown }));
vi.mock("@/lib/kudos-actions", () => ({ sendKudos: vi.fn(async () => send.result) }));

const { GiveKudos } = await import("./give-kudos");

type Props = Record<string, unknown> & { children?: ReactNode };

/** Every element in `node` (props.children, depth first) that `match` accepts. */
function findAll(node: ReactNode, match: (props: Props) => boolean): Props[] {
  const out: Props[] = [];
  const queue: ReactNode[] = [node];
  while (queue.length > 0) {
    const next = queue.shift();
    if (Array.isArray(next)) queue.unshift(...next);
    else if (isValidElement(next)) {
      const props = (next as ReactElement<Props>).props;
      if (match(props)) out.push(props);
      queue.unshift(props.children);
    }
  }
  return out;
}

const ada = { id: 9, displayName: "Ada", jobTitle: null, avatarUrl: null };

/** Calls the dialog with the states open 0, search 1, selected 2, message 3 seeded. */
function render(seed: { selected?: unknown; message?: string; search?: string }) {
  shim.index = 0;
  shim.seed = new Map<number, unknown>([
    [0, true],
    [1, seed.search ?? ""],
    [2, seed.selected ?? null],
    [3, seed.message ?? ""],
  ]);
  return GiveKudos({ people: [ada] }) as ReactNode;
}

/** The ModalDialog's content: the dialog itself is not rendered by the shim. */
const content = (tree: ReactNode) => (tree as ReactElement<Props>).props.children;

beforeEach(() => {
  shim.sets = [];
  shim.transitions = [];
  shim.pending = false;
  send.result = { ok: true };
});

describe("the kudos draft while sending (#182)", () => {
  /** The one fieldset around the draft, and the controls inside it. */
  const draft = (tree: ReactNode) => {
    const [fieldset] = findAll(
      content(tree),
      (p) => "disabled" in p && "className" in p && !("type" in p),
    );
    const inside = (match: (props: Props) => boolean) => findAll(fieldset.children, match);
    return { fieldset, inside };
  };

  it("holds the recipient, the values and the message in one fieldset, disabled while pending", () => {
    shim.pending = true;
    const picked = draft(render({ selected: ada, message: "Thanks" }));
    expect(picked.fieldset.disabled).toBe(true);
    expect(picked.inside((p) => p["aria-label"] === "removeRecipient")).toHaveLength(1);
    expect(picked.inside((p) => p.type === "radio")).toHaveLength(5);
    expect(picked.inside((p) => "maxLength" in p)).toHaveLength(1);

    const searching = draft(render({ search: "Ad" }));
    expect(searching.fieldset.disabled).toBe(true);
    expect(searching.inside((p) => p.placeholder === "searchColleague")).toHaveLength(1);
    expect(searching.inside((p) => p.type === "button")).toHaveLength(1); // the suggestion
  });

  it("is open again once the send is no longer pending", () => {
    expect(draft(render({ selected: ada, message: "Thanks" })).fieldset.disabled).toBe(false);
  });

  it("a success clears and closes; a failure keeps the draft and shows the error", async () => {
    const submit = async () => {
      shim.sets = [];
      shim.transitions = [];
      const tree = render({ selected: ada, message: "Thanks" });
      const [form] = findAll(content(tree), (p) => "onSubmit" in p);
      (form.onSubmit as (event: object) => void)({ preventDefault: () => {} });
      await Promise.all(shim.transitions);
      return shim.sets;
    };
    // States: open 0, search 1, selected 2, message 3, value 4, error 5.
    expect(await submit()).toEqual([
      [5, null],
      [1, ""],
      [2, null],
      [3, ""],
      [4, "teamwork"],
      [5, null],
      [0, false],
    ]);
    send.result = { ok: false, code: "unavailable" };
    expect(await submit()).toEqual([
      [5, null],
      [5, "unavailable"],
    ]);
  });
});

describe("the kudos message length (#198)", () => {
  it("stops the textarea at the cms limit", () => {
    const [textarea] = findAll(content(render({ selected: ada })), (p) => "maxLength" in p);
    expect(textarea.maxLength).toBe(MAX_KUDOS_MESSAGE);
  });
});
