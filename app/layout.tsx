import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import { isTheme, THEME_COOKIE, type Theme } from '@/lib/theme';
import { savedTheme } from '@/lib/server/saved-theme';
import { VitalsReporter } from '@/components/vitals-reporter';
import { ToasterOnce } from '@/components/app/toaster';
import './globals.css';

/** Inter, actually loaded this time.
 *
 * app/styles/base.css has asked for `Inter` since the first design pass and
 * nothing ever loaded it — no next/font, no @font-face, no stylesheet link — so
 * on every device without it installed the site drew in the fallback. The name
 * was a wish.
 *
 * Self-hosted from a pinned npm package rather than next/font/google: the
 * bytes are in package-lock.json with an integrity hash, so the build does not
 * depend on fonts.gstatic.com being up and a file cannot change upstream
 * without the lockfile saying so. That is the same reason vendor/ and the
 * generated palette are committed. 48 KB for the variable weight axis and 52 KB
 * for its italic, latin only — Arabic and Urdu have no Inter glyphs, so the
 * browser falls back per glyph to the system's own, which is what should
 * happen.
 *
 * `display: swap` and the metric-adjusted Arial fallback next/font generates
 * are what keep the swap from moving the page: the fallback is scaled to
 * Inter's own metrics, so the line that renders before the font arrives is the
 * height the line will be afterwards. */
const inter = localFont({
  src: [
    {
      path: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
      weight: '100 900',
      style: 'normal',
    },
    {
      path: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2',
      weight: '100 900',
      style: 'italic',
    },
  ],
  display: 'swap',
  variable: '--font-inter',
  adjustFontFallback: 'Arial',
  fallback: ['ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'Hikmah Workspace',
  description:
    'Your connected AI workspace for conversations, coding, agent tools and experimental research.',
  // Declared, because the icon is an SVG and there is no favicon.ico: without
  // this every page load asked for /favicon.ico and logged a 404.
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  // A link to this workspace pasted into a chat rendered as a bare URL with no
  // name, no summary and no mark. Titles are per page; these carry across.
  applicationName: 'Hikmah',
  openGraph: {
    type: 'website',
    siteName: 'Hikmah',
    title: 'Hikmah Workspace',
    description:
      'Chat, code, a terminal and your own tools in one place. Runs happen on the server, so an answer is not something you have to sit and watch.',
  },
  twitter: {
    card: 'summary',
    title: 'Hikmah Workspace',
    description:
      'Chat, code, a terminal and your own tools in one place. Runs happen on the server, so an answer is not something you have to sit and watch.',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Stamped here rather than after hydration, so the page is the owner's colour
  // in its first paint and not after a flash of the other one.
  //
  // The cookie is written by the workspace, and since the chat became the
  // default surface an owner can sign in, land on /chat and never mount the
  // thing that writes it — so a saved dark theme showed as light until they
  // happened to open /workspace. When there is no cookie, the saved preference
  // is read directly.
  const cookie = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookie) ? cookie : await savedTheme();
  return (
    <html lang="en" className={inter.variable} data-theme={theme} data-astryx-theme="hikmah">
      <body className="antialiased">
        {children}
        {/* Renders nothing. It is here rather than per surface because the two
            pages a stranger judges the product on — the landing page and
            sign-in — are the two nobody would have remembered to instrument. */}
        <VitalsReporter />
        {/* The one toast host for the whole app; surfaces must not mount their
            own. */}
        <ToasterOnce />
      </body>
    </html>
  );
}
