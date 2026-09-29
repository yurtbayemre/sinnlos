/** Kudos and celebrations (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

export type KudosValue = "teamwork" | "innovation" | "leadership" | "customer-focus" | "excellence";

export interface Kudos {
  id: number;
  documentId?: string;
  message: string;
  value: KudosValue;
  from?: UserLite | null;
  to?: UserLite | null;
  createdAt?: string;
}

export interface Celebration {
  user: UserLite;
  type: "work-anniversary" | "birthday";
  /**
   * Opt-in birthday occurrence (YYYY-MM-DD, month/day only — no year of
   * birth). Absent for work anniversaries: emitting an absolute anniversary
   * date alongside `years` would leak the reconstructable hireDate (issue #10).
   */
  date?: string;
  /** Only present for work anniversaries — birthdays never expose the year. */
  years?: number;
  daysUntil: number;
}
