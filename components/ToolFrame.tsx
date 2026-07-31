"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { LOE_URL } from "../lib/constants";

/**
 * The Sales Toolbox app, embedded.
 *
 * It reads `?view=` to open a screen directly, which is what lets the toolbox
 * cards link to a tool rather than to a second copy of their own landing page.
 * Having skipped that landing page on the way in, the app's "← Dashboard"
 * shouldn't reveal it on the way out — so it posts up here and the shell
 * navigates instead.
 *
 * The destination is this component's to decide, not the frame's: the message
 * is only ever a request to go back, and `back` says where that is.
 */
export default function ToolFrame({
  view,
  title,
  back = "/toolbox",
  height = "calc(100dvh - 73px)",
}: {
  view?: string | null;
  title: string;
  back?: string;
  height?: string;
}) {
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the frame we mounted may move the shell.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { type?: string } | null;
      if (!data || data.type !== "npsa:navigate") return;
      router.push(back);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router, back]);

  const base = LOE_URL.replace(/\/+$/, "");
  const src = view ? `${base}/?view=${encodeURIComponent(view)}` : base;

  return (
    <iframe
      ref={frame}
      src={src}
      style={{ width: "100%", height, border: "none", display: "block" }}
      title={title}
    />
  );
}
