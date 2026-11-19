/**
 * A published process as readers get it (v1.1 "Tools", BPMN). The list reads
 * the metadata only; `diagram` (the BPMN 2.0 XML) comes with the detail read.
 */
export interface Process {
  id: number;
  documentId?: string;
  title: string;
  summary?: string | null;
  diagram?: string | null;
  updatedAt?: string | null;
  department?: { id: number; documentId?: string; name: string; slug: string } | null;
}
