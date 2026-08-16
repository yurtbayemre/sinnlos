import { auth } from "@/auth";
import { getCommentSection } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { LiveCommentSection } from "./live-comment-section";

/**
 * Server entry point: loads the initial comments/reactions, then hands off
 * to LiveCommentSection, which keeps the data fresh on the client (refetch
 * after own mutations + visible-tab polling for other sessions' changes).
 *
 * The target is addressed by its documentId (issue #11) — the numeric row id
 * of a published entry changes on every publish and would orphan the thread.
 */
export async function CommentSection({ target }: { target: CommentTarget }) {
  const session = await auth();
  const userId = session?.user?.id;
  const initial = await getCommentSection(target);

  return <LiveCommentSection target={target} currentUserId={userId} initial={initial} />;
}
