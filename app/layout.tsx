import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { isTheme, THEME_COOKIE } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hikmah Workspace',
  description:
    'Your connected AI workspace for conversations, coding, agent tools and experimental research.',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Stamped here rather than after hydration, so the page is the owner's colour
  // in its first paint and not after a flash of the other one. The workspace
  // keeps this cookie current; /chat, which never mounts that provider, has no
  // other way to know.
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  return (
    <html lang="en" data-theme={isTheme(saved) ? saved : 'light'}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
