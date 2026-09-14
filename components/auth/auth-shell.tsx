/** The frame the four authentication pages share.
 *
 * Sign in, sign up, forgot and reset are the same card with different contents.
 * Written once so they cannot drift into looking like four different products,
 * which is what a stranger's first two screens must not do.
 */
import Link from 'next/link';
import { HikmahIcon } from '@/components/kernel/icons';
import { APP_RELEASE, BUILD_ID } from '@/lib/release';

export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Links below the form: the other page in the pair, and the way back. */
  footer?: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        {/* A banner landmark, so these four pages are not a main and a footer
            with the brand loose inside the main. */}
        <header>
          <Link href="/" className="auth-brand" aria-label="Hikmah home">
            <HikmahIcon name="orbit" size={38} />
            <span>Hikmah</span>
          </Link>
        </header>
        <p className="auth-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
        {children}
        {footer}
        <footer>
          App v{APP_RELEASE} <span>Build {BUILD_ID.slice(0, 7)}</span>
        </footer>
      </section>
    </main>
  );
}
