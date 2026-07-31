"use client";

import ToolFrame from "../../components/ToolFrame";

export default function MarketingPage() {
  // Back from the embedded marketing dashboard belongs on the native one, which
  // is the shell's home page — not the Sales Toolbox.
  return <ToolFrame view="marketing" title="Marketing" back="/" height="100%" />;
}
