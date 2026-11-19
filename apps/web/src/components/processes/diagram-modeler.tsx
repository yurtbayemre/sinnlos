"use client";

// Loaded in the browser only, on the process editor (diagram-modeler-lazy.tsx). The
// "powered by bpmn.io" watermark the modeler draws stays visible and uncovered: it is
// part of the bpmn-js license, and nothing here or in the editor may hide or overlap it.
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { useEffect, useRef } from "react";
import Modeler from "bpmn-js/lib/Modeler";
import { hasUnsafePaint } from "@sinnlos/domain";

/** What the editor asks of the modeler. */
export interface ModelerApi {
  /**
   * The current diagram as formatted BPMN 2.0 XML (saveXML({ format: true })), or null
   * while the author has not edited it since it was loaded (it is then stored as it is).
   */
  save(): Promise<string | null>;
  /**
   * Replaces the diagram (an imported file) and answers it as formatted XML; rejects
   * when bpmn-js cannot read it. The diagram counts as unedited afterwards.
   */
  load(xml: string): Promise<string>;
}

/** The editing pauses this long before the editor is told about the new XML. */
const CHANGE_DELAY_MS = 400;

/**
 * The bpmn-js Modeler on one diagram (v1.1 "Tools"). `xml` is read once, at mount: the
 * editor remounts the modeler (a key) to load another one, and `load` replaces it for
 * an import. `onEdit` fires at once on an edit, `onChange` reports the XML when the
 * author pauses (never after a load: an untouched diagram is not rewritten in a
 * normalised form). The canvas SVG is the tab stop and the target of the modeler's keyboard
 * shortcuts (diagram-js 15: delete, copy, undo of the selected elements); it gets the
 * accessible name `label`. Placing and connecting elements needs a mouse or touch, which
 * the editor says in words.
 */
export default function DiagramModeler({
  xml,
  label,
  onEdit,
  onChange,
  onApi,
  onFailed,
}: {
  xml: string;
  label: string;
  onEdit: () => void;
  onChange: (xml: string) => void;
  onApi: (api: ModelerApi | null) => void;
  onFailed: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  // The latest callbacks, without re-creating the modeler when the editor re-renders.
  const callbacks = useRef({ onEdit, onChange, onApi, onFailed });
  useEffect(() => {
    callbacks.current = { onEdit, onChange, onApi, onFailed };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let edited = false;
    const modeler = new Modeler({ container: element });
    const canvas = element.querySelector("svg");
    canvas?.setAttribute("role", "group");
    canvas?.setAttribute("aria-label", label);
    const save = async () => (await modeler.saveXML({ format: true })).xml ?? "";
    modeler.on("commandStack.changed", () => {
      edited = true;
      callbacks.current.onEdit();
      clearTimeout(timer);
      timer = setTimeout(() => {
        void save().then((saved) => {
          if (current) callbacks.current.onChange(saved);
        });
      }, CHANGE_DELAY_MS);
    });
    callbacks.current.onApi({
      save: async () => {
        // An edit still waiting for its timer is part of what is saved.
        clearTimeout(timer);
        return edited ? save() : null;
      },
      load: async (next) => {
        clearTimeout(timer);
        // bpmn-js replaces its definitions before a render can still reject (a file
        // without a BPMNDiagram): put the previous diagram back, or a save would store
        // the refused one. A file that fails to parse changes nothing: then the undo
        // history stays.
        const definitions = modeler.getDefinitions();
        const previous = await save().catch(() => null);
        try {
          await modeler.importXML(next);
        } catch (error) {
          if (previous !== null && modeler.getDefinitions() !== definitions) {
            await modeler.importXML(previous).catch(() => undefined);
          }
          throw error;
        }
        modeler.get<{ zoom(level: string): void }>("canvas").zoom("fit-viewport");
        edited = false;
        return save();
      },
    });
    // A color that is no plain color would make the browser request an address: nothing is
    // drawn (the editor says so, and an import can replace the diagram).
    const loading = hasUnsafePaint(xml)
      ? Promise.reject(new Error("unsafe paint"))
      : modeler.importXML(xml);
    loading
      .then(() => {
        if (current) modeler.get<{ zoom(level: string): void }>("canvas").zoom("fit-viewport");
      })
      .catch(() => {
        if (current) callbacks.current.onFailed();
      });
    return () => {
      current = false;
      clearTimeout(timer);
      callbacks.current.onApi(null);
      modeler.destroy();
    };
    // xml (and label) are read once: the editor remounts (key) to load another diagram.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={container}
      className="relative h-[28rem] overflow-hidden rounded-xl border bg-card focus-within:ring-2 focus-within:ring-ring md:h-[36rem]"
    />
  );
}
