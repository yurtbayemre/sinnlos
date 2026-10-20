import type { DutyPerson } from "@/components/manage/duty-plan-editor";
import { kudosRecipientQuery, toKudosRecipients } from "@/lib/people-dto";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { fetchAllUsers } from "@/lib/users";

/**
 * The people a duty plan's shifts can name (v0.18): the directory without
 * blocked accounts, by name, as the kudos picker reads it (lib/people-dto.ts).
 */
export async function loadDutyPeople(): Promise<{ people: DutyPerson[]; failed: boolean }> {
  const res = await tryFetch(() => fetchAllUsers<UserLite>(kudosRecipientQuery(null)), "people");
  const people = toKudosRecipients(res.data?.users ?? [], null).map(
    ({ id, displayName, jobTitle }) => ({ id, displayName, jobTitle }),
  );
  return { people, failed: res.failed };
}
