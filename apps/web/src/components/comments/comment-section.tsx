import { getSession } from "@/lib/session";
import { getCommentSections } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { summarize, type CommentSectionData } from "@/lib/reaction-summary";
import { canComment, canDeleteOwnComments, canReact } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveCommentSection, type CommentControls } from "./live-comment-section";

/**
 * Server entry points of the comment sections: load the initial comments
 * and reactions, then hand off to LiveCommentSection, which keeps the data
 * fresh on the client (its page's CommentSectionsProvider).
 *
 * The target is addressed by its documentId (issue #11) — the numeric row id
 * of a published entry changes on every publish and would orphan the thread.
 *
 * The controls follow the viewer's role (SH02, lib/roles.ts, fail-closed):
 * the comment form needs comment create, the reaction bar reaction create,
 * the delete button on one's own comments comment delete. A role without
 * them (guest; `authenticated` for the delete) reads the thread without
 * them instead of meeting a refusal. The CMS decides anyway.
 */

/** The section controls of a role (lib/roles.ts; the CMS enforces the same grants). */
export function commentControlsFor(role: string | null | undefined): CommentControls {
  return {
    comment: canComment(role),
    react: canReact(role),
    deleteOwn: canDeleteOwnComments(role),
  };
}

/** The sections of a page, loaded together, by commentSectionKey. */
export type CommentSectionsLoad = Promise<Map<string, CommentSectionData>>;

/** Most targets per getCommentSections call (the action refuses more). */
const LOAD_CHUNK = 200;

const commentSectionKey = (target: CommentTarget) => `${target.type}:${target.documentId ?? ""}`;

/**
 * Starts ONE batched load for every section of a page (WD04):
 * getCommentSections reads one reactions request per 50 targets plus each
 * target's comment window, instead of two requests per section. The page
 * passes the promise to each CommentSection, which waits for it inside its
 * own Suspense boundary, so the rest of the page streams first.
 */
export function loadCommentSections(targets: CommentTarget[]): CommentSectionsLoad {
  const chunks: CommentTarget[][] = [];
  for (let i = 0; i < targets.length; i += LOAD_CHUNK) {
    chunks.push(targets.slice(i, i + LOAD_CHUNK));
  }
  const load = Promise.all(chunks.map((chunk) => getCommentSections(chunk))).then((results) => {
    const sections = new Map<string, CommentSectionData>();
    chunks.forEach((chunk, i) => {
      chunk.forEach((target, j) => {
        const section = results[i]?.[j];
        if (section) sections.set(commentSectionKey(target), section);
      });
    });
    return sections;
  });
  // Every CommentSection awaits the promise and sees its error (an expired
  // session's redirect included); a page that renders none must not leave
  // it unhandled.
  load.catch(() => undefined);
  return load;
}

export async function CommentSection({
  target,
  sections,
}: {
  target: CommentTarget;
  /** The page's batched load (loadCommentSections); without it, this target alone. */
  sections?: CommentSectionsLoad;
}) {
  // getViewer() is one /api/me read per render, shared by every section.
  const [session, viewer, loaded] = await Promise.all([
    getSession(),
    getViewer(),
    sections ?? loadCommentSections([target]),
  ]);
  const userId = session?.user?.id;
  const initial = loaded.get(commentSectionKey(target)) ?? {
    comments: [],
    reactions: summarize([], userId),
  };

  return (
    <LiveCommentSection
      target={target}
      currentUserId={userId}
      initial={initial}
      controls={commentControlsFor(viewer.role)}
    />
  );
}

/** What a section shows while its page's batch is still loading. */
export function CommentSectionFallback() {
  return <Skeleton aria-hidden="true" className="h-24 w-full" />;
}
