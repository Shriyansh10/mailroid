import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { GlobalProviders } from "@web/providers/global";

// Geist VF is a variable face, which is the part that matters here: the
// marketing page sets weights at 460 / 540 / 600, the in-between values a
// static font cannot produce. DESIGN.md names those sub-default weights as
// the brand's typographic signature and suggests Inter Variable as a
// substitute for Super Sans VF — Geist satisfies the same requirement,
// is already vendored, and needs no font fetch at build time.
const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

const TAGLINE =
  "Mailroid is an AI workspace built on top of Gmail and Google Calendar.";

export const metadata: Metadata = {
  metadataBase: new URL("https://mailroid.app"),
  title: {
    default: "Mailroid — finish work where the conversation started",
    template: "%s · Mailroid",
  },
  // The canonical sentence, verbatim. It is the same string in the hero
  // subhead; if one changes, change both.
  description: TAGLINE,
  applicationName: "Mailroid",
  openGraph: {
    type: "website",
    siteName: "Mailroid",
    title: "Finish work where the conversation started.",
    description: TAGLINE,
  },
  twitter: {
    card: "summary_large_image",
    title: "Finish work where the conversation started.",
    description: TAGLINE,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // next-themes sets the theme class on <html> in a pre-hydration script, so
    // server and first-client markup differ here by design.
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <GlobalProviders>{children}</GlobalProviders>
      </body>
    </html>
  );
}
