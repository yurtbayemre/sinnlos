import { getTranslations } from "next-intl/server";
import { youtubeEmbedUrl, youtubeVideoId } from "@/lib/training-shared";

/**
 * Fail-closed render gate for lesson videos (issue #29) — the
 * AUTHORITATIVE XSS layer: the stored videoUrl is parsed, the video id
 * extracted, and the embed URL REBUILT from a template. The stored
 * string is never rendered. Anything that doesn't validate renders
 * nothing (the CMS lifecycle already told the author on save; old rows
 * or db-level writes may still carry junk — they stay invisible).
 *
 * Referrer (FX09): YouTube's embedded player needs the embedding origin in
 * the Referer and refuses to play without it (player "Error 153"), so the
 * iframe sends `strict-origin-when-cross-origin`, the site-wide policy
 * (Traefik and Caddy both set it): the origin only, never the path or query
 * of the lesson page. The former `no-referrer` overrode that policy and
 * broke playback.
 *
 * Server Component — no client JS beyond the iframe itself.
 */
export async function LessonVideo({ videoUrl }: { videoUrl?: string | null }) {
  const videoId = youtubeVideoId(videoUrl);
  if (!videoId) return null;
  const t = await getTranslations("training");

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl border bg-black">
      <iframe
        src={youtubeEmbedUrl(videoId)}
        title={t("videoTitle")}
        className="h-full w-full"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="encrypted-media; picture-in-picture; fullscreen"
        loading="lazy"
      />
    </div>
  );
}
