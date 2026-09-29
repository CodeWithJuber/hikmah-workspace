'use client';
/** Phone or desktop, from the same 900px switch the chat shell uses.
 *
 * Server snapshot is "not narrow": the entry screens render nothing until
 * hydration tells the truth, so a desktop never flashes the phone UI. */
import { useSyncExternalStore } from 'react';
import { NARROW_QUERY } from './breakpoints';

function subscribe(change: () => void) {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
