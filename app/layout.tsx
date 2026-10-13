import type { Metadata, Viewport } from "next";
import { Libre_Franklin, Source_Code_Pro, Source_Sans_3 } from "next/font/google";
import "./globals.css";
import AppShell from "../components/AppShell";

// One type system across the toolbox, the client intake form and the letters:
// Libre Franklin for headings and figures, Source Sans 3 for everything else,
// Source Code Pro for codes and IDs. Self-hosted by next/font, so there is no
// external stylesheet request at runtime.
const franklin = Libre_Franklin({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-head",
  display: "swap",
});

const sourceSans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-sans",
  display: "swap",
});

const sourceCode = Source_Code_Pro({
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
      className={`${franklin.variable} ${sourceSans.variable} ${sourceCode.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
