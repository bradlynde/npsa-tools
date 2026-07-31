"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ToolFrame from "../../components/ToolFrame";

function LOEFrame() {
  const view = useSearchParams().get("view");
  return <ToolFrame view={view} title="Sales Toolbox" back="/toolbox" />;
}

export default function LOEPage() {
  return (
    <Suspense fallback={null}>
      <LOEFrame />
    </Suspense>
  );
}
