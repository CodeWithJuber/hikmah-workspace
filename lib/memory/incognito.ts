/** Per-session incognito for memory: while on, chat runs neither read nor
 * write memory, and learning never captures the session's exchanges.
 *
 * Session-scoped, never server-persisted: the toggle lives on the Memory
 * screen, but it writes nothing to /api/memory or /api/chat-settings, so the
 * persistent memory settings keep their meaning. A closed tab ends the
 * session; a reload of the same tab keeps it (sessionStorage), because what
 * was incognito staying incognito is the promise the toggle makes.
 *
 * The wiring reads this at run-queue time rather than trusting a flag the
 * client sent with every render: components/chat/chat-view.tsx folds it into
 * the transport config, and app/api/conversations/[id]/runs/route.ts gates
 * the saved-memory block, the `remember` auto-save, and the learning consent
 * on the parsed request flag.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'hikmah-memory-incognito';

function readStored(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

function setCurrent(value: boolean) {
  if (current === value) return;
  current = value;
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (value) sessionStorage.setItem(KEY, '1');
      else sessionStorage.removeItem(KEY);
    }
  } catch {
    /* Storage is best effort; the module state is the truth. */
  }
  for (const notify of listeners) notify();
}

/** Whether this session is incognito. Read when a run is queued. */
export function getIncognito(): boolean {
  return current;
}

/** Flip the session's incognito mode. Client-only; nothing touches the server. */
export function setIncognito(value: boolean): void {
  setCurrent(value);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

function getSnapshot(): boolean {
  return current;
}

/** React binding for the toggle UI. */
export function useIncognito(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
