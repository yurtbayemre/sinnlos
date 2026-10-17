/** Departments and teams (WD01, split from lib/types.ts). */
import type { MediaImage, UserLite } from "./common";

export interface Department {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  headerImage?: MediaImage | null;
  head?: UserLite | null;
  members?: UserLite[];
  teams?: Team[];
}

export interface Team {
  avatar?: MediaImage | null;
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  department?: Department | null;
  lead?: UserLite | null;
  members?: UserLite[];
}
