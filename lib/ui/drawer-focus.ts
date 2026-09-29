/**
 * Focus management for the chat shell's custom drawers (PR-11).
 *
 * The drawers in `components/chat/chat-shell.tsx` are hand-rolled (a plain
 * aside/div, not the radix Sheet), so they own their focus contract: when a
 * drawer opens as a modal, focus moves inside and Tab cycles within it;
 * Escape closes; on close focus returns to whatever opened the drawer.
 *
 * The contract lives here as small pure functions over a minimal element
 * shape so it is unit-testable without a DOM — `tests/drawer-focus.test.mjs`
 * drives it with fakes. The shell passes real DOM nodes, which satisfy the
 * shapes structurally.
 */

/** The tab order inside a drawer: every keyboard-reachable control. */
const FOCUSABLE_SELECTOR =
  'button:not(:disabled),a[href],summary,input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';

/** The smallest element surface the helpers need. */
export interface FocusableElement {
  focus(): void;
  getClientRects(): { length: number };
  closest(selectors: string): unknown;
}

/** The smallest drawer-root surface the helpers need. */
export interface FocusRoot {
  querySelectorAll(selectors: string): ArrayLike<FocusableElement>;
  // `unknown`, not the element type: real DOM `contains` takes `Node | null`,
  // and the helpers never need more than passing the candidate through.
  contains(node: unknown): boolean;
  focus(): void;
}

/** Visible, keyboard-reachable elements inside the drawer, in tab order. */
export function focusableElements(root: FocusRoot): FocusableElement[] {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

/** Focus the first control in the drawer, or the drawer itself when empty. */
export function focusFirstInDrawer(root: FocusRoot): void {
  const first = focusableElements(root)[0];
  if (first) first.focus();
  else root.focus();
}

export type DrawerKeyOutcome = 'close' | 'trapped' | 'ignored';

/** The smallest key-event surface the trap needs. */
export interface DrawerKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

/**
 * The drawer's key contract. Escape closes the drawer; Tab cycles focus
 * inside it (wrapping at both ends, and pulling focus back in when it somehow
 * escaped); every other key is left alone. Returns what happened so the
 * caller — which owns the open/closed state — can act on it.
 */
export function handleDrawerKey(
  root: FocusRoot,
  activeElement: FocusableElement | null,
  event: DrawerKeyEvent,
): DrawerKeyOutcome {
  if (event.key === 'Escape') {
    event.preventDefault();
    return 'close';
  }
  if (event.key !== 'Tab') return 'ignored';
  const items = focusableElements(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    // Nothing to cycle through: hold focus on the drawer itself.
    event.preventDefault();
    root.focus();
    return 'trapped';
  }
  const outside = !activeElement || !root.contains(activeElement);
  const wrapForward = !event.shiftKey && (activeElement === last || outside);
  const wrapBackward = event.shiftKey && (activeElement === first || outside);
  if (wrapForward || wrapBackward) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return 'trapped';
  }
  return 'ignored';
}

/**
 * Where focus goes when the drawer closes: the element that opened it, when
 * that element is still a useful target. `document.body` is never useful —
 * focusing it is a silent no-op that strands keyboard users (it is what
 * `document.activeElement` reports for deep links like `?settings=connection`
 * that open a drawer with no opener) — and neither is a detached or inert
 * element. Fallbacks run in order; the shell passes its topbar controls
 * (desktop Conversations button, then the phone's back chevron).
 */
export function pickReturnFocusTarget(
  previous: FocusableElement | null,
  fallbacks: ReadonlyArray<FocusableElement | null | undefined>,
  body: FocusableElement | null,
): FocusableElement | null {
  const usable = (element: FocusableElement | null | undefined): element is FocusableElement =>
    !!element &&
    element !== body &&
    element.getClientRects().length > 0 &&
    !element.closest('[inert]');
  if (usable(previous)) return previous;
  for (const fallback of fallbacks) {
    if (usable(fallback)) return fallback;
  }
  return null;
}
