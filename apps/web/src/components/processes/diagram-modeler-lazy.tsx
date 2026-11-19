"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";

function Loading() {
  const t = useTranslations("manage.processes.diagram");
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {t("loading")}
    </p>
  );
}

/** The bpmn-js modeler, loaded in the browser only and only by the process editor (ssr: false). */
export const DiagramModelerLazy = dynamic(() => import("./diagram-modeler"), {
  ssr: false,
  loading: () => <Loading />,
});
