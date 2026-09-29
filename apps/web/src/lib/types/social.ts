/** Comments, reactions and notifications (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

export interface Comment {
  id: number;
  documentId?: string;
  body: string;
  targetType: "announcement" | "wiki-page";
  /**
   * documentId of the commented entry — NOT the numeric id: Strapi 5
   * re-publishing deletes + recreates the published row (new numeric id),
   * while the documentId is stable across the publish lifecycle (issue #11).
   */
  targetDocumentId?: string | null;
  createdAt?: string;
  author?: UserLite | null;
}

export type EmojiType = "thumbsup" | "heart" | "celebrate" | "lightbulb" | "laugh";

export interface Reaction {
  id: number;
  emoji: EmojiType;
  targetType: "announcement" | "wiki-page";
  /** documentId of the reacted-to entry — the publish-stable anchor (issue #11). */
  targetDocumentId?: string | null;
  author?: UserLite | null;
}

export interface ReactionSummary {
  emoji: EmojiType;
  count: number;
  reacted: boolean;
}

export interface Notification {
  id: number;
  documentId?: string;
  type: "announcement" | "comment" | "event" | "kudos";
  title: string;
  link?: string;
  readAt?: string | null;
  createdAt?: string;
  actor?: UserLite | null;
  recipient?: UserLite | null;
}
