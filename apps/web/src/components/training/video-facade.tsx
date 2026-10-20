"use client";

import { Play } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";

/**
 * The lesson video frame. Its attributes are the security layer of issue #29
 * and FX09: a sandbox, and the origin as Referer (YouTube's player refuses
 * to play without it, "Error 153"; the former `no-referrer` broke playback).
 */
export function LessonVideoFrame({
  src,
  title,
  ref,
}: {
  src: string;
  title: string;
  ref?: Ref<HTMLIFrameElement>;
}) {
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      className="h-full w-full"
      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      referrerPolicy="strict-origin-when-cross-origin"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
    />
  );
}

/**
 * Click to load (issue #37): until the viewer asks for the video, nothing is
 * requested from YouTube (no player scripts, no thumbnail), so opening a
 * lesson neither loads the player nor connects to Google. The click renders
 * the frame with autoplay and moves the focus into it.
 */
export function VideoFacade({
  src,
  title,
  playLabel,
  notice,
}: {
  src: string;
  title: string;
  playLabel: string;
  notice: string;
}) {
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const noticeId = useId();

  useEffect(() => {
    if (playing) frame.current?.focus();
  }, [playing]);

  if (playing) return <LessonVideoFrame ref={frame} src={src} title={title} />;
  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-describedby={noticeId}
      className="group flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-white/15 transition-colors group-hover:bg-white/25">
        <Play className="size-8 translate-x-0.5" aria-hidden="true" />
      </span>
      <span className="text-sm font-medium">{playLabel}</span>
      <span id={noticeId} className="max-w-sm text-center text-xs text-white/70">
        {notice}
      </span>
    </button>
  );
}
