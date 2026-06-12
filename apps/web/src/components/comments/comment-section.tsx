import { auth } from "@/auth";
import { getCommentSection } from "@/lib/comment-actions";
import { LiveCommentSection } from "./live-comment-section";

/**
 * Server entry point: loads the initial comments/reactions, then hands off
 * to LiveCommentSection, which keeps the data fresh on the client (refetch
 * after own mutations + visible-tab polling for other sessions' changes).
 */
export async function CommentSection({
  targetType,
  targetId,
}: {
  targetType: "announcement" | "wiki-page";
  targetId: number;
}) {
  const session = await auth();
  const userId = (session?.user as any)?.id as number | undefined;
  const initial = await getCommentSection(targetType, targetId);

  return (
    <LiveCommentSection
      targetType={targetType}
      targetId={targetId}
      currentUserId={userId}
      initial={initial}
    />
  );
}
