import { tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";

/** One published process as the readers show it (v1.1 "Tools"). */
export interface ProcessView {
  documentId: string;
  title: string;
  summary: string;
  updatedAt: string | null;
  department: { name: string; slug: string } | null;
}

/** The detail read: the list's fields plus the BPMN 2.0 XML ("" when the row holds none). */
export interface ProcessDetailView extends ProcessView {
  diagram: string;
}

export interface ProcessesView {
  processes: ProcessView[];
  /** The processes could not be read: say so, never "no processes". */
  failed: boolean;
  truncated: boolean;
}

/** The published processes by title, without their diagrams. */
export async function loadProcesses(): Promise<ProcessesView> {
  const res = await tryFetch(() => api.processes.list(), "processes");
  if (res.failed || !res.data) return { processes: [], failed: true, truncated: false };
  const processes = res.data.data.map((row) => ({
    documentId: row.documentId ?? String(row.id),
    title: row.title,
    summary: row.summary ?? "",
    updatedAt: row.updatedAt ?? null,
    department: row.department ? { name: row.department.name, slug: row.department.slug } : null,
  }));
  return { processes, failed: false, truncated: res.data.truncated };
}

/**
 * One published process with its diagram, or null: an unknown or unpublished id is not
 * found. A failed read throws (detail-page strategy, WD07: (app)/error.tsx retries).
 */
export async function loadProcess(documentId: string): Promise<ProcessDetailView | null> {
  const row = (await api.processes.one(documentId)).data[0];
  if (!row) return null;
  return {
    documentId: row.documentId ?? String(row.id),
    title: row.title,
    summary: row.summary ?? "",
    updatedAt: row.updatedAt ?? null,
    department: row.department ? { name: row.department.name, slug: row.department.slug } : null,
    diagram: row.diagram ?? "",
  };
}
