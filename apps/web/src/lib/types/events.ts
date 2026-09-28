/** Events and RSVPs (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";
import type { Department } from "./org";

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
