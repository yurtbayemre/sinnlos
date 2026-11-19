"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { MERMAID_MAX_TEXT_SIZE, renderMermaid } from "@/lib/mermaid-render";

/**
 * A ```mermaid fence of a Markdown body (components/markdown.tsx hands it the
 * fence's text). React owns every node, nothing replaces DOM by hand:
 *
 *   - on the server and on the first client render it is the plain fence,
 *     `<pre><code class="language-mermaid">`, exactly the markup any other
 *     fence gets, so there is nothing to hydrate differently and the source is
 *     what a reader without JavaScript sees;
 *   - after mount an effect renders the diagram (lib/mermaid-render.ts, which
 *     loads Mermaid with a dynamic `import()` only now: that is why no page
 *     without a fence ever fetches the library) and the SVG replaces the
 *     source through state;
 *   - a diagram that does not parse, or a text over Mermaid's maxTextSize,
 *     keeps the source and adds a one-line hint. Nothing throws;
 *   - the theme follows the app's (next-themes) and renders again on a switch;
 *     the old SVG stays until the new one is ready.
 */
export function MermaidBlock({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const tooLong = source.length > MERMAID_MAX_TEXT_SIZE;
  // `svg: null` is a render that failed.
  const [done, setDone] = useState<{ source: string; svg: string | null } | null>(null);

  useEffect(() => {
    if (tooLong) return;
    const abort = new AbortController();
    renderMermaid(source, dark, abort.signal).then(
      (svg) => {
        if (!abort.signal.aborted) setDone({ source, svg });
      },
      () => {
        if (!abort.signal.aborted) setDone({ source, svg: null });
      },
    );
    return () => abort.abort();
  }, [source, dark, tooLong]);

  const current = done?.source === source ? done : null;
  if (current?.svg) return <MermaidFigure svg={current.svg} source={source} />;
  return (
    <>
      <pre>
        <code className="language-mermaid">{source}</code>
      </pre>
      {(tooLong || current) && <MermaidHint tooLong={tooLong} />}
    </>
  );
}

function MermaidHint({ tooLong }: { tooLong: boolean }) {
  const t = useTranslations("markdown");
  return (
    <p className="text-sm text-muted-foreground">
      {t(tooLong ? "mermaidTooLong" : "mermaidError")}
    </p>
  );
}

/**
 * The drawn diagram. Mermaid names the SVG itself only when the diagram has an
 * accTitle, so the group carries a name for the other ones. The source stays
 * one disclosure away (keyboard and screen readers, copying).
 */
function MermaidFigure({ svg, source }: { svg: string; source: string }) {
  const t = useTranslations("markdown");
  return (
    <div role="group" aria-label={t("mermaidDiagram")} className="my-5">
      {/* Mermaid's own output after its DOMPurify pass (securityLevel "strict"); not-prose: the typography's `p` margins would shift its HTML labels. */}
      <div className="not-prose overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t("mermaidSource")}
        </summary>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </details>
    </div>
  );
}
