"use client";

import { LOE_URL } from "../../lib/constants";

export default function LOEPage() {
  return (
    <iframe
      src={LOE_URL}
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        display: "block",
      }}
      title="Sales Toolbox"
    />
  );
}
