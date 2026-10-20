"use client";

import { Play } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Click to load (issue #37): until the viewer asks for the video, `children`
 * (the frame, built on the server by LessonVideo) is not rendered, so
 * nothing is requested from YouTube (no player scripts, no thumbnail, no
 * connection to Google). The click renders it and moves the focus into it.
 */
export function VideoFacade({
  playLabel,
  notice,
  children,
}: {
  playLabel: string;
  notice: string;
  children: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const noticeId = useId();

  useEffect(() => {
    if (playing) box.current?.querySelector("iframe")?.focus();
  }, [playing]);

  if (playing) {
    return (
      <div ref={box} className="h-full w-full">
        {children}
      </div>
    );
  }
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
