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
  /**
   * documentId of the commented entry — NOT the numeric id: Strapi 5
   * re-publishing deletes + recreates the published row (new numeric id),
   * while the documentId is stable across the publish lifecycle (issue #11).
   */
  targetDocumentId?: string | null;
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
  /** documentId of the reacted-to entry — the publish-stable anchor (issue #11). */
  targetDocumentId?: string | null;
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
  rsvpEnabled?: boolean;
  capacity?: number | null;
  location?: string | null;
  url?: string | null;
  departments?: Department[];
  organizer?: UserLite | null;
  createdAt?: string;
}

export type RsvpStatus = "yes" | "no" | "maybe";

export interface EventRsvp {
  id: number;
  documentId?: string;
  /** documentId of the event (stable across re-publishes). */
  targetDocumentId: string;
  status: RsvpStatus;
  respondedAt?: string | null;
  user?: UserLite | null;
}

/** Per-event aggregate the events page derives from the raw RSVP rows. */
export interface EventRsvpSummary {
  /** Display names of "yes" responders (names are public, per decision). */
  yesNames: string[];
  yesCount: number;
  maybeCount: number;
  noCount: number;
  myStatus: RsvpStatus | null;
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

export type ClassifiedCategory =
  | "sale"
  | "giveaway"
  | "wanted"
  | "service-offer"
  | "service-wanted";

export interface ClassifiedImage {
  id: number;
  url?: string;
  name?: string;
  formats?: {
    thumbnail?: { url?: string };
    small?: { url?: string };
    medium?: { url?: string };
  } | null;
}

export interface Classified {
  id: number;
  documentId?: string;
  title: string;
  description?: string;
  category?: ClassifiedCategory;
  price?: number | null;
  priceNegotiable?: boolean;
  location?: string | null;
  images?: ClassifiedImage[] | null;
  /** Date (YYYY-MM-DD); ads past this date disappear from the public list. */
  expiresAt?: string;
  author?: UserLite | null;
  createdAt?: string;
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
