"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LOE_URL } from "../../lib/constants";

function LOEFrame() {
  const params = useSearchParams();
  const view = params.get("view");

  // The Sales Toolbox app reads ?view= to jump straight to a screen. It
  // currently honours "marketing"; any other value simply lands on its
  // dashboard, so passing one through is safe and starts working the moment
  // that app adds support.
  const base = LOE_URL.replace(/\/+$/, "");
  const src = view ? `${base}/?view=${encodeURIComponent(view)}` : base;

  return (
    <iframe
      src={src}
      style={{
        width: "100%",
        height: "calc(100dvh - 73px)",
        border: "none",
        display: "block",
      }}
      title="Sales Toolbox"
    />
  );
}

export default function LOEPage() {
  return (
    <Suspense fallback={null}>
      <LOEFrame />
    </Suspense>
  );
}
