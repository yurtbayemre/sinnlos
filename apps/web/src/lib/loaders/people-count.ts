import { tryFetch } from "@/lib/safe-fetch";
import { fetchAllUsers } from "@/lib/users";
import { FAILED_COUNT, type Count } from "./count";

/**
 * The people count of the dashboard and /manage/analytics (WD10, WD03).
 * /api/users answers a bare array without a total (and user.count for
 * every role was rejected on purpose), so it is the id-only directory walk.
 * The pages stream it in its own Suspense boundary: the walk (up to 20
 * requests) must not hold back their first flush. A failed walk is "–",
 * not 0; a walk cut at the 2000-user cap is "2000+".
 */
export async function loadPeopleCount(label: string): Promise<Count> {
  const result = await tryFetch(() => fetchAllUsers("fields[0]=id"), label);
  if (result.failed || !result.data) return FAILED_COUNT;
  return { value: result.data.users.length, truncated: result.data.truncated };
}
