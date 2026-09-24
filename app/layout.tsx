import type { Metadata, Viewport } from "next";
import { Newsreader, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
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

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "NPSA Tools", template: "%s · NPSA Tools" },
  description: "Nonprofit Security Advisors — internal tools",
  applicationName: "NPSA Tools",
  appleWebApp: { title: "NPSA Tools" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1824" },
  ],
};

// Applies the theme and the sidebar state before first paint, so dark mode never
// flashes white and the sidebar never jumps. Mirrors lib/theme.ts: no saved
// theme means "match the system", and no saved sidebar state means collapsed on
// screens 1100px and narrower.
const PRE_PAINT = `(function(){try{var t=localStorage.getItem('npsa-theme');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.body.classList.add('dark');}catch(e){}try{var s=localStorage.getItem('npsa-sidebar');if(s!=='collapsed'&&s!=='expanded')s=window.matchMedia('(max-width: 1100px)').matches?'collapsed':'expanded';document.documentElement.setAttribute('data-sidebar',s);}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
