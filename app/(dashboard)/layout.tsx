import type { Metadata } from "next";

// A route group so the Company Report, a client page, can still set its tab title.
export const metadata: Metadata = { title: "Company Report" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
