/** Departments and teams (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

export interface Department {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  head?: UserLite | null;
  members?: UserLite[];
  teams?: Team[];
}

export interface Team {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  department?: Department | null;
  lead?: UserLite | null;
  members?: UserLite[];
}
