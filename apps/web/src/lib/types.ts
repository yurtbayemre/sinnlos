/**
 * Lightweight types for the Strapi entities the frontend renders.
 * Fields are optional-by-default because population varies per query;
 * these exist to replace the previous `any` casts with real signal.
 */

export interface UserLite {
  id: number;
  username?: string;
  email?: string;
  displayName?: string;
  jobTitle?: string;
  avatar?: { url?: string } | null;
  phone?: string;
  officeLocation?: string;
  department?: { id: number; name: string; slug: string } | null;
  manager?: UserLite | null;
  directReports?: UserLite[];
  hireDate?: string;
}

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
  pages?: WikiPage[];
}

export interface WikiSpace {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  visibility?: "public" | "role" | "department" | "team";
  pages?: WikiPage[];
}

export interface WikiPage {
  id: number;
  documentId?: string;
  title: string;
  slug: string;
  summary?: string | null;
  body?: string | null;
  updatedAt?: string;
  author?: UserLite | null;
  lastEditor?: UserLite | null;
  space?: WikiSpace | null;
}

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
  attributes?: Record<string, unknown>;
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

export interface Comment {
  id: number;
  documentId?: string;
  body: string;
  targetType: "announcement" | "wiki-page";
  targetId: number;
  createdAt?: string;
  author?: UserLite | null;
  parent?: { id: number } | null;
  replies?: Comment[];
}

export type EmojiType = "thumbsup" | "heart" | "celebrate" | "lightbulb" | "laugh";

export interface Reaction {
  id: number;
  emoji: EmojiType;
  targetType: "announcement" | "wiki-page";
  targetId: number;
  author?: UserLite | null;
}

export interface ReactionSummary {
  emoji: EmojiType;
  count: number;
  reacted: boolean;
}

export interface Event {
  id: number;
  documentId?: string;
  title: string;
  description?: string | null;
  start: string;
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  url?: string | null;
  departments?: Department[];
  organizer?: UserLite | null;
  createdAt?: string;
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

export interface Poll {
  id: number;
  documentId?: string;
  question: string;
  options: string[];
  closesAt?: string | null;
  anonymous?: boolean;
  departments?: Department[];
  author?: UserLite | null;
  createdAt?: string;
}

export interface PollResults {
  poll: {
    id: number;
    question: string;
    options: string[];
    closesAt?: string | null;
    anonymous?: boolean;
  };
  counts: number[];
  total: number;
  myVoteIndex: number | null;
}

export interface Document {
  id: number;
  documentId?: string;
  title: string;
  description?: string | null;
  category?: "policy" | "form" | "template" | "guide" | "other";
  file?: { url?: string; name?: string; size?: number; mime?: string } | null;
  departments?: Department[];
  uploadedBy?: UserLite | null;
  createdAt?: string;
  updatedAt?: string;
}

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
  date: string;
  /** Only present for work anniversaries — birthdays never expose the year. */
  years?: number;
  daysUntil: number;
}
