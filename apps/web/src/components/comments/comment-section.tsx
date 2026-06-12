import { auth } from "@/auth";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import type { Comment, Reaction, EmojiType, ReactionSummary } from "@/lib/types";
import { CommentThread } from "./comment-thread";
import { ReactionBar } from "@/components/reactions/reaction-bar";

const ALL_EMOJIS: EmojiType[] = ["thumbsup", "heart", "celebrate", "lightbulb", "laugh"];

function summarize(reactions: Reaction[], userId?: number): ReactionSummary[] {
  const map = new Map<EmojiType, { count: number; reacted: boolean }>();
  for (const emoji of ALL_EMOJIS) {
    map.set(emoji, { count: 0, reacted: false });
  }
  for (const r of reactions) {
    const entry = map.get(r.emoji);
    if (entry) {
      entry.count++;
      if (userId != null && r.author?.id === userId) entry.reacted = true;
    }
  }
  return ALL_EMOJIS.map((emoji) => ({
    emoji,
    ...map.get(emoji)!,
  }));
}

export async function CommentSection({
  targetType,
  targetId,
}: {
  targetType: "announcement" | "wiki-page";
  targetId: number;
}) {
  const session = await auth();
  const userId = (session?.user as any)?.id as number | undefined;

  const [commentsRes, reactionsRes] = await Promise.all([
    strapi<StrapiListResponse<Comment>>(
      `/api/comments?filters[targetType][$eq]=${targetType}&filters[targetId][$eq]=${targetId}&populate[author]=true&sort=createdAt:asc&pagination[pageSize]=100`,
      { noCache: true },
    ).catch(() => ({ data: [] as Comment[] })),
    strapi<StrapiListResponse<Reaction>>(
      `/api/reactions?filters[targetType][$eq]=${targetType}&filters[targetId][$eq]=${targetId}&populate[author]=true&pagination[pageSize]=500`,
      { noCache: true },
    ).catch(() => ({ data: [] as Reaction[] })),
  ]);

  const comments = (commentsRes as any).data ?? [];
  const reactions = (reactionsRes as any).data ?? [];

  return (
    <div className="space-y-4">
      <ReactionBar
        targetType={targetType}
        targetId={targetId}
        reactions={summarize(reactions, userId)}
      />
      <CommentThread
        targetType={targetType}
        targetId={targetId}
        comments={comments}
        currentUserId={userId}
      />
    </div>
  );
}
