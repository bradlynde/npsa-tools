"use client";
import { useEffect, useState } from "react";

/** True while the media query matches; false on the server and on first paint. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const set = () => setOn(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, [query]);
  return on;
}
