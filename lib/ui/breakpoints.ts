/** The canonical breakpoint ladder.
 *
 * CSS cannot read var() inside @media, so the ladder is documented in
 * app/styles/tokens.css and mirrored here for matchMedia / JS decisions.
 * tests/breakpoints.test.mjs keeps the two in sync — edit both or neither.
 *
 * The shell's 900px drawer/tab-bar switch predates this ladder and is kept
 * as NARROW_QUERY: it is a chrome breakpoint, not a content breakpoint.
 */

export const BREAKPOINTS = {
  /** Small phone (320–360px class). */
  xs: 360,
  /** Large phone. */
  sm: 480,
  /** Tablet portrait. */
  md: 768,
  /** Tablet landscape / small laptop. */
  lg: 1024,
  /** Desktop. */
  xl: 1280,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;

/** max-width query for "at or below this breakpoint". */
export const maxQuery = (bp: BreakpointName): string => `(max-width: ${BREAKPOINTS[bp]}px)`;

/** min-width query for "at or above this breakpoint". */
export const minQuery = (bp: BreakpointName): string => `(min-width: ${BREAKPOINTS[bp]}px)`;

/** The app shell's nav chrome switch (drawer ↔ bottom tab bar). Predates the
 * ladder; kept stable so the shell never disagrees with itself. */
export const NARROW_QUERY = '(max-width: 900px)';

/** True when the viewport is a phone-class screen. */
export function isPhoneViewport(width: number): boolean {
  return width < BREAKPOINTS.md;
}
