/** The document library (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";
import type { Department } from "./org";

export interface Document {
  id: number;
  documentId?: string;
  title: string;
  description?: string | null;
  category?: "policy" | "form" | "template" | "guide" | "other";
  file?: { url?: string; name?: string; size?: number; mime?: string } | null;
  departments?: Department[];
  /** "departments" with no department left: moderators only (scopedNeedsRetarget). */
  audience?: "all" | "departments" | null;
  /** v0.20: readers confirm they read it (POST /api/acknowledgements, targetType document). */
  requiresAck?: boolean;
  uploadedBy?: UserLite | null;
  createdAt?: string;
  updatedAt?: string;
}
