import type { DutyShift, DutyShiftTemplate } from "@sinnlos/domain";

/** A published duty plan as readers get it (v0.18, "Zuständigkeiten"). */
export interface DutyPlan {
  id: number;
  documentId?: string;
  name: string;
  note?: string | null;
  department?: { id: number; documentId?: string; name: string; slug: string } | null;
  shiftTemplates?: DutyShiftTemplate[] | null;
  shifts?: DutyShift[] | null;
}
