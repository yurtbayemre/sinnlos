import { validateDutyShifts, type DutyShift } from "@sinnlos/domain";
import { tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";
import type { UserLite } from "@/lib/types";
import { fetchAllUsers } from "@/lib/users";

/** One published duty plan as the readers show it (v0.18). */
export interface DutyPlanView {
  documentId: string;
  name: string;
  note: string | null;
  department: { name: string; slug: string } | null;
  /** Valid shifts only, sorted by start (@sinnlos/domain validateDutyShifts). */
  shifts: DutyShift[];
}

/** A person on a shift: the directory's name and phone (contact fields are staff-only, issue #10). */
export interface DutyPersonView {
  name: string | null;
  phone: string | null;
}

export interface DutiesView {
  plans: DutyPlanView[];
  people: Readonly<Record<number, DutyPersonView>>;
  /** The plans could not be read: say so, never "nobody on duty". */
  failed: boolean;
  truncated: boolean;
}

/** The /api/users query of the people a set of shifts names. */
export function dutyPeopleQuery(ids: readonly number[]): string {
  return [
    "fields[0]=displayName",
    "fields[1]=username",
    "fields[2]=phone",
    ...ids.map((id, i) => `filters[id][$in][${i}]=${id}`),
  ].join("&");
}

/**
 * The published duty plans and the people their shifts name. A failed
 * people read leaves the names unknown; the shifts still show.
 */
export async function loadDuties(): Promise<DutiesView> {
  const res = await tryFetch(() => api.dutyPlans.list(), "duty plans");
  if (res.failed || !res.data) return { plans: [], people: {}, failed: true, truncated: false };
  const plans = res.data.data.map((row) => {
    const shifts = validateDutyShifts(row.shifts ?? null);
    return {
      documentId: row.documentId ?? String(row.id),
      name: row.name,
      note: row.note ?? null,
      department: row.department ? { name: row.department.name, slug: row.department.slug } : null,
      shifts: "error" in shifts ? [] : shifts.shifts,
    };
  });
  const ids = [...new Set(plans.flatMap((plan) => plan.shifts.map((shift) => shift.userId)))];
  const people: Record<number, DutyPersonView> = {};
  if (ids.length > 0) {
    const users = await tryFetch(
      () => fetchAllUsers<UserLite>(dutyPeopleQuery(ids)),
      "duty people",
    );
    for (const user of users.data?.users ?? []) {
      people[user.id] = {
        name: user.displayName || user.username || null,
        phone: user.phone || null,
      };
    }
  }
  return { plans, people, failed: false, truncated: res.data.truncated };
}
