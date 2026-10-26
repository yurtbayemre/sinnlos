/**
 * Data protection (v0.28, deep-dive plan-v028-rev2.md + rev3): the shapes
 * the cms answers and the web reads for the training evidence, the export
 * (GDPR Art. 15) and the anonymisation (Art. 17), all admin_role only, plus
 * the neutral name of an anonymised person.
 */
import type { TrainingCompletionMode } from "./training.js";

/** What an anonymised person is called (their display name; the web's label for an id it cannot resolve). */
export const FORMER_PERSON_LABEL = { en: "Former person", de: "Ehemalige Person" } as const;

/** The neutral name in `locale` (German for "de", English otherwise). */
export function formerPersonLabel(locale: string | null | undefined): string {
  return locale === "de" ? FORMER_PERSON_LABEL.de : FORMER_PERSON_LABEL.en;
}

// ---------------------------------------------------------------------------
// Training evidence.

/** A course or lesson as the receipt saw it. */
export interface TrainingSnapshotRef {
  documentId: string;
  title: string;
  /** The published version (ISO 8601); null when unknown (backfilled). */
  publishedAt: string | null;
}

/**
 * `lesson-progress.snapshot` (schema-private): written with the receipt, or
 * filled later from the then current rows (`backfilled`, historical facts
 * unknown). Never sent to a learner.
 */
export interface TrainingSnapshot {
  v: 1;
  course: TrainingSnapshotRef | null;
  lesson: TrainingSnapshotRef | null;
  completionMode: TrainingCompletionMode | null;
  /** true: the lesson had questions and every answer was right; null: no questions, or unknown when backfilled. */
  quizPassed: true | null;
  /** The due day (YYYY-MM-DD, APP_TIME_ZONE) the receipt stops counting; null: no expiry, or unknown when backfilled. */
  validUntil: string | null;
  learner: { displayName: string; email: string | null } | null;
  backfilled?: true;
}

/**
 * The published versions the player showed (GET /api/lessons/:id/player
 * `data.version`), sent back with the completion. A completion against
 * another version answers 409 with `details.code` TRAINING_VERSION_CHANGED.
 */
export interface TrainingVersion {
  course: string;
  lesson: string;
}

export const TRAINING_VERSION_CHANGED = "changed";

/** One receipt in GET /api/user-management/:id/training-evidence. */
export interface TrainingEvidenceRow {
  id: number;
  /** ISO 8601. */
  completedAt: string | null;
  course: { documentId: string | null; title: string };
  /** The course's published version at completion (ISO 8601); null: unknown. */
  version: string | null;
  lesson: { documentId: string; title: string };
  completionMode: TrainingCompletionMode | null;
  quiz: "passed" | "none" | "unknown";
  validUntil: string | null;
  validity: "until" | "noExpiry" | "unknown";
  /** Filled after the fact (receipts from before v0.28): titles are the later ones. */
  backfilled: boolean;
  /** The newest receipt of this person for this lesson: the current proof. */
  current: boolean;
}

export interface TrainingEvidenceResponse {
  data: {
    user: { id: number; displayName: string };
    rows: TrainingEvidenceRow[];
  };
}

// ---------------------------------------------------------------------------
// Export (Art. 15): GET /api/user-management/:id/export.

/** A category deliberately not in the export, with the reason (shown to the data subject). */
export interface UserExportExclusion {
  category: string;
  reason: string;
}

export interface UserExport {
  meta: {
    /** ISO 8601: the export was read at this time (no single database snapshot). */
    generatedAt: string;
    /** The intranet's URL (PUBLIC_URL / the cms URL), or null. */
    instance: string | null;
    /** Where purposes, recipients and retention are described (docs/data-protection.md). */
    inventory: string;
  };
  account: Record<string, unknown>;
  organisation: Record<string, unknown>;
  /** One list per data class, every row the person is linked to. */
  content: Record<string, Record<string, unknown>[]>;
  audit: Record<string, unknown>[];
  notIncluded: UserExportExclusion[];
}

// ---------------------------------------------------------------------------
// Anonymisation (Art. 17): GET (preview) and POST (run) /api/user-management/:id/anonymise.

/** The classes the anonymisation deletes, counted. */
export const ANONYMISE_DELETED = [
  "reactions",
  "pollVotes",
  "rsvps",
  "kudosReceived",
  "notifications",
  "acknowledgements",
  "classifieds",
] as const;

export type AnonymiseDeletedClass = (typeof ANONYMISE_DELETED)[number];

/** The classes that stay, counted (they keep a neutral author or the retention rule). */
export const ANONYMISE_KEPT = [
  "announcements",
  "wikiPages",
  "documents",
  "events",
  "polls",
  "comments",
  "kudosGiven",
  "dutyPlans",
  "kpis",
  "trainingReceipts",
] as const;

export type AnonymiseKeptClass = (typeof ANONYMISE_KEPT)[number];

export interface AnonymiseCounts {
  deleted: Record<AnonymiseDeletedClass, number>;
  /**
   * Other people's notifications that named the person: the name is
   * replaced. In a run's answer: the rewrites this request committed.
   */
  rewritten: { notifications: number };
  kept: Record<AnonymiseKeptClass, number>;
}

export interface AnonymisePreviewResponse {
  data: {
    id: number;
    username: string;
    displayName: string;
    blocked: boolean;
    anonymisedAt: string | null;
    /** A snapshot (advisory): the run counts again under its locks. */
    counts: AnonymiseCounts;
  };
}

/** POST body: the person's current username, typed by the admin. */
export interface AnonymiseRequest {
  confirm: string;
}

export interface AnonymiseResponse {
  data: {
    id: number;
    /** ISO 8601. */
    anonymisedAt: string;
    counts: AnonymiseCounts;
    /**
     * The rewrite of other people's notifications naming the person, after
     * the commit (v0.30): `rewritten` = `counts.rewritten.notifications`,
     * committed by this request; `remaining` = still linked at the final
     * count (0: done; more: the nightly erasure sweep repeats them; null:
     * that count failed, the sweep still repeats whatever is left).
     */
    notifications: { rewritten: number; remaining: number | null };
    /** The avatar after the commit: removed, or kept (linked elsewhere, or the removal failed: delete it in the Media Library). */
    avatar: { id: number; removed: boolean } | null;
  };
}

/** `details.code` of the anonymisation's 409s and 400. */
export const ANONYMISE_CODES = {
  /** 409: already anonymised. */
  anonymised: "anonymised",
  /** 409: block the person first. */
  notBlocked: "notBlocked",
  /** 400: `confirm` is not the person's username. */
  confirm: "confirm",
} as const;
