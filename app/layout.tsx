import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { isTheme, THEME_COOKIE, type Theme } from '@/lib/theme';
import { savedTheme } from '@/lib/server/saved-theme';
import './globals.css';

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
    <html lang="en" data-theme={theme}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
