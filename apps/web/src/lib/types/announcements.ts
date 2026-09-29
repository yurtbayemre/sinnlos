/**
 * Announcements and their read receipts (WD01, split from lib/types.ts;
 * the Strapi v4 `attributes` leftover on Announcement is gone: Strapi 5
 * answers flat rows).
 */
import type { UserLite } from "./common";

export interface Announcement {
  id: number;
  documentId?: string;
  title?: string;
  body?: string;
  pinned?: boolean;
  createdAt?: string;
  author?: UserLite | null;
  requiresAck?: boolean;
  /** Date (YYYY-MM-DD) until which a mandatory announcement should be acknowledged. */
  ackDeadline?: string | null;
}

export interface Acknowledgement {
  id: number;
  documentId?: string;
  targetType: "announcement" | "document";
  /**
   * documentId of the acknowledged entry — NOT the numeric id: Strapi 5
   * re-publishing deletes + recreates the published row (new numeric id),
   * while the documentId stays stable across the publish lifecycle.
   */
  targetDocumentId: string;
  acknowledgedAt?: string | null;
  user?: UserLite | null;
  createdAt?: string;
}
