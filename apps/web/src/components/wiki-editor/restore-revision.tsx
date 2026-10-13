"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import type { AuthoringDocumentStatus } from "@sinnlos/domain";
import { ConflictDialog, FormAlert } from "@/components/manage/editor-chrome";
import { useManageFlash } from "@/components/manage/flash";
import { metaOf, useAuthoringEditor } from "@/components/manage/use-authoring-editor";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { restoreWikiRevision } from "@/lib/manage/wiki-page-actions";

/** The page as the history read it (`editable`): its documentId and version. */
export interface RestorePage {
  documentId: string;
  version: string;
  status: AuthoringDocumentStatus;
  publishedAt: string | null;
}

const NO_FIELDS: readonly string[] = [];

/**
 * "Restore this version" (deep-dive decision 06 §J3 "Restore", §L5; batch
 * 16 plan, lane 16C item 6): asks first (ConfirmDialog; a legacy entry says
 * that it brings back the text only), then restores and publishes in one
 * request under the page's version (If-Match). The page re-renders with
 * the new entry at the top. A 412 (someone saved the page since the
 * history was opened) opens the conflict dialog: Reload, or restore over
 * the current version (Overwrite, an explicit choice).
 */
export function RestoreRevision({
  page,
  revisionId,
  legacy,
}: {
  /** A stable object from the server render: a reload resets to it. */
  page: RestorePage;
  revisionId: number;
  /** A `before` entry (older format): the text only. */
  legacy: boolean;
}) {
  const t = useTranslations("manage.wiki.history");
  const tc = useTranslations("manage.common");
  const flash = useManageFlash();
  const [confirm, setConfirm] = useState(false);
  const editor = useAuthoringEditor({
    formId: "wiki-history",
    initialMeta: metaOf(page),
    fieldOrder: NO_FIELDS,
    source: page,
    onReset: () => undefined,
  });

  const restore = () => {
    setConfirm(false);
    editor.run(
      "publish",
      (version) => restoreWikiRevision(page.documentId, version ?? "", revisionId),
      { onSuccess: () => flash(t("restored")) },
    );
  };

  return (
    <div className="space-y-3">
      <FormAlert area="wiki" scope="editor" failure={editor.failure} alertRef={editor.alertRef} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        trigger={
          <Button
            type="button"
            disabled={editor.pending}
            onClick={(event) => editor.rememberInvoker(event.currentTarget)}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            {editor.running ? tc("actions.working") : t("restore")}
          </Button>
        }
        title={t("restoreTitle")}
        description={legacy ? t("restoreBodyLegacy") : t("restoreBody")}
        confirmLabel={t("restoreConfirm")}
        tone="default"
        pending={editor.pending}
        onConfirm={restore}
      />
      <ConflictDialog
        conflict={editor.conflict}
        copyText=""
        pending={editor.pending}
        onReload={() => {
          editor.clearConflict();
          editor.requestReset();
        }}
        onOverwrite={editor.overwrite}
        onClose={editor.clearConflict}
        returnFocus={editor.invokerRef}
      />
    </div>
  );
}
