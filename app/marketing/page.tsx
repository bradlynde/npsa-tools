"use client";

import { LOE_URL } from "../../lib/constants";

export default function MarketingPage() {
  return (
    <iframe
      src={`${LOE_URL}/?view=marketing`}
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        display: "block",
      }}
      title="Marketing"
    />
  );
}
