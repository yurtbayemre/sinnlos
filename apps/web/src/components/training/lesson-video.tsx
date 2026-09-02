import { youtubeEmbedUrl, youtubeVideoId } from "@/lib/training-shared";

/**
 * Fail-closed render gate for lesson videos (issue #29) — the
 * AUTHORITATIVE XSS layer: the stored videoUrl is parsed, the video id
 * extracted, and the embed URL REBUILT from a template. The stored
 * string is never rendered. Anything that doesn't validate renders
 * nothing (the CMS lifecycle already told the author on save; old rows
 * or db-level writes may still carry junk — they stay invisible).
 * Server Component — no client JS beyond the iframe itself.
 */
export function LessonVideo({ videoUrl }: { videoUrl?: string | null }) {
  const videoId = youtubeVideoId(videoUrl);
  if (!videoId) return null;

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border bg-black">
      <iframe
        src={youtubeEmbedUrl(videoId)}
        title="Video"
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        referrerPolicy="no-referrer"
        allow="encrypted-media; picture-in-picture; fullscreen"
        loading="lazy"
      />
    </div>
  );
}
