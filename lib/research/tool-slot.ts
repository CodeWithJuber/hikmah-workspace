/** Extension point for the owner's own algorithms.
 *
 * His maths and research — the Ruh model on the Mizan track, the Quranic
 * Arabic analysis from the lemma-pattern work — are not productized code yet,
 * so v1 ships the slot interface and the registry with nothing registered: an
 * honest stub, not invented maths. The first real slot (Ruh inference)
 * registers here and the dispatcher offers it on the lanes it declares, via
 * `researchSlotNames` in lib/runs/dispatch.ts.
 *
 * A slot is server-side: registration happens in the worker process, never
 * from the browser, and a slot's tools are offered only on the lanes it
 * names.
 */
import type { DispatchLane } from '../runs/dispatch.ts';

export type ResearchToolSlot = {
  /** Tool name as the model will see it, e.g. 'ruh_infer'. */
  name: string;
  /** One line for the registry log. */
  description: string;
  /** Dispatcher lanes that may offer this slot's tools. */
  lanes: DispatchLane[];
  /** The AI SDK tool definitions. Built lazily so a lane that never fires
   * pays nothing for a slot it never uses. */
  build: () => Record<string, unknown>;
};

const slots = new Map<string, ResearchToolSlot>();

/** The registry lives on globalThis (like __hikmahRunService in
 * lib/runs/service.ts) rather than module scope: the worker and the route
 * must see the same registrations even if the module is bundled twice. */
function registry(): Map<string, ResearchToolSlot> {
  const g = globalThis as Record<string, unknown>;
  let map = g.__hikmahResearchSlots as Map<string, ResearchToolSlot> | undefined;
  if (!map) {
    map = slots;
    g.__hikmahResearchSlots = map;
  }
  return map;
}

/** Register a research tool slot. Re-registering a name replaces it. */
export function registerResearchSlot(slot: ResearchToolSlot): void {
  if (!slot || !slot.name || typeof slot.build !== 'function')
    throw new Error('registerResearchSlot: a slot needs a name and a build() function');
  if (!Array.isArray(slot.lanes) || slot.lanes.length === 0)
    throw new Error('registerResearchSlot: a slot must name at least one lane');
  registry().set(slot.name, { ...slot, lanes: [...slot.lanes] });
}

/** Remove a registration. False when nothing was registered under the name. */
export function unregisterResearchSlot(name: string): boolean {
  return registry().delete(name);
}

/** Slot names registered for a lane, in registration order. v1: none. */
export function researchSlotNames(lane: DispatchLane): string[] {
  return [...registry().values()]
    .filter((slot) => slot.lanes.includes(lane))
    .map((slot) => slot.name);
}
