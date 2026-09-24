import type { Metadata } from "next";

// A route group so the dashboard, a client page, can still set its tab title.
export const metadata: Metadata = { title: "Dashboard" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
