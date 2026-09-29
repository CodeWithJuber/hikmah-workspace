import type { Memory } from './store';

/** Decide what the master Memory switch does, honestly.
 *
 * The switch is all-on/all-off over *saved* memories — suggestions are
 * untouched, because no run reads a suggestion until the person accepts it.
 * When at least one saved memory is enabled, the switch turns everything off;
 * when none is enabled, it turns everything on. Memories already in the
 * target state are left alone, so the caller only writes what changed.
 *
 * The caller runs the returned ids through the existing per-item
 * `PUT /api/memory` (`update(id, { enabled })`) — persistent and reversible,
 * no backend change, no fake global flag.
 */
export function planMemoryMasterToggle(memories: Memory[]): {
  enable: boolean;
  ids: string[];
} {
  const saved = memories.filter((memory) => memory.status === 'saved');
  const enable = !saved.some((memory) => memory.enabled);
  const ids = saved.filter((memory) => memory.enabled !== enable).map((memory) => memory.id);
  return { enable, ids };
}
