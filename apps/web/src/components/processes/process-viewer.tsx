"use client";

// The bpmn.io stylesheets load with this chunk only (next/dynamic, ssr: false in
// process-viewer-lazy.tsx), so no other page pays for them. Nothing in the app may
// hide or cover the "powered by bpmn.io" watermark the viewer draws in its container:
// it is part of the bpmn-js license (process-viewer.test.ts pins that no style names it).
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { useEffect, useRef, useState } from "react";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { AlertCircle, Download } from "lucide-react";
import { hasUnsafePaint } from "@sinnlos/domain";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { downloadBlob } from "@/lib/browser-download";
import { diagramFileName } from "@/lib/process-diagram";

/**
 * One process diagram (v1.1 "Tools"): the bpmn-js NavigatedViewer (zoom and move, no
 * editing), with downloads as .bpmn (the stored XML, always available) and .svg (the
 * drawn diagram). XML bpmn-js cannot parse shows an error panel and keeps the .bpmn
 * download; the canvas never stays blank without a word. The description (summary) is
 * the diagram's text alternative and sits above it on the page.
 */
export default function ProcessViewer({ title, xml }: { title: string; xml: string }) {
  const t = useTranslations("processes");
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<NavigatedViewer | null>(null);
  const [loaded, setLoaded] = useState<"loading" | "ready" | "failed">("loading");
  const [downloadFailed, setDownloadFailed] = useState(false);
  // A color that is no plain color would make the browser request an address (the cms
  // refuses it too; this covers a row stored before that): nothing is drawn, the
  // .bpmn download stays.
  const unsafe = hasUnsafePaint(xml);
  const state = unsafe ? "failed" : loaded;

  useEffect(() => {
    if (!container.current || unsafe) return;
    let current = true;
    const instance = new NavigatedViewer({ container: container.current });
    viewer.current = instance;
    setLoaded("loading");
    instance
      .importXML(xml)
      .then(() => {
        if (!current) return;
        instance.get<{ zoom(level: string): void }>("canvas").zoom("fit-viewport");
        setLoaded("ready");
      })
      .catch(() => {
        if (current) setLoaded("failed");
      });
    return () => {
      current = false;
      viewer.current = null;
      instance.destroy();
    };
  }, [xml, unsafe]);

  const saveSvg = async () => {
    setDownloadFailed(false);
    try {
      const { svg } = (await viewer.current?.saveSVG()) ?? { svg: "" };
      if (svg === "") throw new Error("no svg");
      downloadBlob(new Blob([svg], { type: "image/svg+xml" }), diagramFileName(title, "svg"));
    } catch {
      setDownloadFailed(true);
    }
  };

  return (
    <div className="space-y-3">
      {state === "failed" ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{xml.trim() === "" ? t("noDiagram") : t("diagramError")}</span>
        </div>
      ) : null}
      {/* The canvas is a picture: its text version is the description above it. */}
      <div
        ref={container}
        role="img"
        aria-label={t("diagramLabel", { title })}
        className={
          state === "failed"
            ? "hidden"
            : "relative h-[26rem] overflow-hidden rounded-xl border bg-card md:h-[34rem]"
        }
      />
      {state === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loadingDiagram")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={xml.trim() === ""}
          onClick={() =>
            downloadBlob(
              new Blob([xml], { type: "application/xml" }),
              diagramFileName(title, "bpmn"),
            )
          }
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("downloadBpmn")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state !== "ready"}
          onClick={() => void saveSvg()}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("downloadSvg")}
        </Button>
        {downloadFailed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("downloadFailed")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
