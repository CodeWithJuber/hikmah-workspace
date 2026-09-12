/** The saved theme, in a place both chat surfaces and the server can read.
 *
 * The preference itself lives in the workspace, which is a single JSON blob
 * behind an authenticated fetch — too late and too expensive for a layout that
 * has to decide what colour the page is before anything renders. So the
 * workspace also mirrors it into a cookie, and the root layout stamps
 * `data-theme` from that: /chat gets the owner's theme without mounting the
 * workspace provider, and the workspace itself stops flashing light before
 * hydration.
 *
 * There is deliberately no `prefers-color-scheme` fallback. The app always has
 * an explicit stored preference and it always wins, so a media query could only
 * ever paint the wrong colour for one frame before the cookie value replaced
 * it.
 */
export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'hikmah-theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** A year, because a theme is not a session, and same-site so it is never sent
 * anywhere but here. Readable by script: the workspace writes it from the
 * browser as the preference changes. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
