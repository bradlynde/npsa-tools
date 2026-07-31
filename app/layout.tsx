import type { Metadata } from "next";
import { Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "../components/AppShell";

// Self-hosted by next/font — no external stylesheet request at runtime.
const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
  // Newsreader ships no fallback-override metrics in this next version.
  adjustFontFallback: false,
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NPSA Tools",
  description: "Nonprofit Security Advisors — Tools Dashboard",
};

// Applies the saved theme before first paint so dark mode never flashes white.
const THEME_SCRIPT = `(function(){try{if(localStorage.getItem('npsa-theme')==='dark'){document.body.classList.add('dark')}}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${newsreader.variable} ${plexMono.variable}`}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        style={
          {
            // --font-sans is the third type role; the other two come from next/font.
            "--font-sans":
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
          } as React.CSSProperties
        }
      >
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
