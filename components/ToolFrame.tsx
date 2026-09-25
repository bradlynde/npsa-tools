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
  height,
}: {
  view?: string | null;
  title: string;
  back?: string;
  /** Defaults to the rest of the viewport (see .tool-frame in globals.css). */
  height?: string;
}) {
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the frame we mounted may move the shell.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { type?: string } | null;
      if (data && data.type === "npsa:auth-request") return postAuth();
      if (!data || data.type !== "npsa:navigate") return;
      router.push(back);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router, back]);

  const base = LOE_URL.replace(/\/+$/, "");
  const src = view ? `${base}/?view=${encodeURIComponent(view)}` : base;

  /*
   * The login has to be relayed too.
   *
   * The framed app calls its own backend straight from the browser, and that
   * backend now requires a credential on every /api route. It asks for the
   * person's login token as soon as it starts, and gets it again on load. The
   * message is addressed to the backend's origin only, so no other page that
   * ends up in this frame can read it.
   */
  function postAuth() {
    let token = "";
    try { token = localStorage.getItem("auth_token") || ""; } catch { /* private mode */ }
    if (token) frame.current?.contentWindow?.postMessage({ type: "npsa:auth", token }, base);
  }

  /*
   * The theme has to be relayed.
   *
   * The framed app is a different origin, so it cannot read the `npsa-theme` we
   * keep in localStorage, and without this it renders light inside a dark shell —
   * a bright rectangle under a dark top bar.
   *
   * Sent on load and again whenever the class on <body> changes, which is what
   * the theme menu (lib/theme.ts) actually does, including when "Match system"
   * follows the computer into dark mode. A MutationObserver rather than a shared
   * store because the theme code owns that class and nothing else needs to know.
   */
  useEffect(() => {
    const post = () => {
      frame.current?.contentWindow?.postMessage(
        { type: "npsa:theme", mode: document.body.classList.contains("dark") ? "dark" : "light" },
        base,
      );
    };
    const ob = new MutationObserver(post);
    ob.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // The frame may already be up (a re-render), so send once now as well as on load.
    post();
    return () => ob.disconnect();
  }, [base]);

  return (
    <iframe
      ref={frame}
      src={src}
      onLoad={() => {
        frame.current?.contentWindow?.postMessage(
          { type: "npsa:theme", mode: document.body.classList.contains("dark") ? "dark" : "light" },
          base,
        );
        postAuth();
      }}
      className="tool-frame"
      style={{ width: "100%", height, border: "none", display: "block" }}
      title={title}
    />
  );
}
