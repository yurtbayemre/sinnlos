import { kudosRecipientQuery, toKudosRecipients, type KudosRecipient } from "@/lib/people-dto";
import { isReadDenied } from "@/lib/roles";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { isOff } from "@/lib/switches";
import { api } from "@/lib/strapi";
import type { UserLite } from "@/lib/types";
import { fetchAllUsers } from "@/lib/users";
import { displayNameOf } from "@/lib/utils";

type Role = string | null | undefined;

/** One kudos of the wall: names resolved (displayNameOf), nothing else of the users. */
export interface KudosEntry {
  id: number;
  /** null: no name to show (the page says "unknown"). */
  fromName: string | null;
  toName: string | null;
  message: string;
  /** A value this web may not know yet (a newer cms) stays as sent. */
  value: string;
  createdAt: string | null;
}

/** A birthday or work anniversary of the next 30 days. */
export interface CelebrationEntry {
  /** user id and type: unique within the list. */
  key: string;
  name: string | null;
  type: "birthday" | "work-anniversary";
  /** Work anniversaries only. */
  years: number | null;
  daysUntil: number;
}

export interface KudosView {
  kudos: KudosEntry[];
  celebrations: CelebrationEntry[];
  /** The give-kudos picker (WD05 DTO: name, job title, thumbnail). */
  recipients: KudosRecipient[];
  /**
   * The kudos or the celebrations read failed: the CMS-down banner. The
   * picker's directory read is not part of it (`recipientsFailed`), as
   * before: the dialog then offers nobody.
   */
  failed: boolean;
  recipientsFailed: boolean;
  /** The kudos read answered with none: the empty state (not on an outage). */
  empty: boolean;
  /** The directory walk stopped at its cap: the picker lacks colleagues. */
  truncated: boolean;
}

/**
 * The /kudos page (WD03). The celebrations are the staff roles' only: the
 * `authenticated` fallback reads kudos but not birthdays and anniversaries
 * (SH02, no request), and nobody reads them while FEATURES_OFF switches
 * `celebrations` off (v0.28). The picker gets every active colleague but the
 * caller (`selfId`).
 */
export async function loadKudos(role: Role, selfId: number | null): Promise<KudosView> {
  const [kudos, celebrations, people] = await Promise.all([
    tryFetch(() => api.kudos.list(), "kudos"),
    isReadDenied(role, "celebrations") || isOff("celebrations")
      ? SKIPPED_READ
      : tryFetch(() => api.celebrations(), "celebrations"),
    tryFetch(() => fetchAllUsers<UserLite>(kudosRecipientQuery(selfId)), "people"),
  ]);
  const kudosList = kudos.data?.data ?? [];

  return {
    kudos: kudosList.map((k) => ({
      id: k.id,
      fromName: displayNameOf(k.from, null),
      toName: displayNameOf(k.to, null),
      message: k.message,
      value: k.value,
      createdAt: k.createdAt ?? null,
    })),
    celebrations: (celebrations.data?.data ?? []).map((c) => ({
      key: `${c.user.id}-${c.type}`,
      name: displayNameOf(c.user, null),
      type: c.type,
      years: c.years ?? null,
      daysUntil: c.daysUntil,
    })),
    recipients: toKudosRecipients(people.data?.users ?? [], selfId),
    failed: kudos.failed || celebrations.failed,
    recipientsFailed: people.failed,
    empty: !kudos.failed && kudosList.length === 0,
    truncated: !!people.data?.truncated,
  };
}
