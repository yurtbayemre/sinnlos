import { redirect } from "next/navigation";

/**
 * Poll authoring moved to /manage/polls/new (deep-dive decision 06 §L1;
 * batch 15 plan, lane 15C item 4): the old address keeps working for
 * bookmarks and the /polls page's "New poll" link. The new page gates
 * itself (moderators only).
 */
export default function NewPollRedirect() {
  redirect("/manage/polls/new");
}
