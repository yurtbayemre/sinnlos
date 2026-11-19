"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";

function Loading() {
  const t = useTranslations("processes");
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {t("loadingDiagram")}
    </p>
  );
}

/**
 * The bpmn-js viewer, loaded in the browser only and only on the page that shows a
 * diagram (v1.1 "Tools"): `ssr: false` is allowed in a client component only, and keeps
 * bpmn-js (it needs a DOM) out of the server render and out of every other route's JS.
 */
export const ProcessViewerLazy = dynamic(() => import("./process-viewer"), {
  ssr: false,
  loading: () => <Loading />,
});
