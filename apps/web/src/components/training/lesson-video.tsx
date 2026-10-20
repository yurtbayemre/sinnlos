import { getTranslations } from "next-intl/server";
import { youtubeEmbedUrl, youtubeVideoId } from "@/lib/training-shared";
import { VideoFacade } from "./video-facade";

/**
 * Fail-closed render gate for lesson videos (issue #29) — the
 * AUTHORITATIVE XSS layer: the stored videoUrl is parsed, the video id
 * extracted, and the embed URL REBUILT from a template. The stored
 * string is never rendered. Anything that doesn't validate renders
 * nothing (the CMS lifecycle already told the author on save; old rows
 * or db-level writes may still carry junk — they stay invisible).
 */
export function lessonVideoSrc(videoUrl: string | null | undefined): string | null {
  const videoId = youtubeVideoId(videoUrl);
  // Autoplay: the viewer already clicked play on the facade.
  return videoId ? `${youtubeEmbedUrl(videoId)}?autoplay=1` : null;
}

/**
 * The lesson video behind a click (issue #37, VideoFacade): the frame with
 * its security attributes (LessonVideoFrame) loads only when the viewer
 * plays the video. Server Component; the facade is the only client part.
 */
export async function LessonVideo({ videoUrl }: { videoUrl?: string | null }) {
  const src = lessonVideoSrc(videoUrl);
  if (!src) return null;
  const t = await getTranslations("training");

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border bg-black">
      <VideoFacade
        src={src}
        title={t("videoTitle")}
        playLabel={t("videoPlay")}
        notice={t("videoNotice")}
      />
    </div>
  );
}
