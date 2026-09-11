import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hikmah Workspace',
  description:
    'Your connected AI workspace for conversations, coding, agent tools and experimental research.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
