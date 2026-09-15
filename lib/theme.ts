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

/**
 * Whether the workspace may write the theme out yet.
 *
 * The workspace provider holds a whole session object, and until the saved one
 * arrives that object is the default — whose theme is `light`. Writing it
 * unconditionally on mount overwrote the `data-theme` the layout above had
 * already stamped from the cookie, and then wrote `light` back into the cookie,
 * so an owner who preferred dark and opened /workspace was flipped to light on
 * every surface until they set it again. It was not a flash; it persisted.
 *
 * A restore that failed is the same situation with no ending: there is no
 * preference to publish, and the cookie already holds the last known truth, so
 * leaving it alone is right.
 */
export function canPublishTheme(state: { loaded: boolean; restoreFailed: boolean }): boolean {
  return state.loaded && !state.restoreFailed;
}
