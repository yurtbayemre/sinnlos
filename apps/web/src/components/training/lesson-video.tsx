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
 * The lesson video behind a click (issue #37): the frame is built here, on
 * the server, and VideoFacade renders it only when the viewer plays the
 * video. The frame's attributes are the security layer (issue #29, FX09):
 * a sandbox, and the origin as Referer (YouTube's player refuses to play
 * without it, "Error 153"; the former `no-referrer` broke playback).
 */
export async function LessonVideo({ videoUrl }: { videoUrl?: string | null }) {
  const src = lessonVideoSrc(videoUrl);
  if (!src) return null;
  const t = await getTranslations("training");

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border bg-black">
      <VideoFacade playLabel={t("videoPlay")} notice={t("videoNotice")}>
        <iframe
          src={src}
          title={t("videoTitle")}
          className="h-full w-full"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        />
      </VideoFacade>
    </div>
  );
}
