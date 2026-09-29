/** Free mode vs plan mode: the two ways a run reaches a model.
 *
 * The connection stores a `freeOnly` switch, and billing knows the tiers
 * (`owner` / `byok` / `managed`), but nothing named the mode the run is
 * actually in — which is what the "Free mode" pill and the pricing page need
 * to read. This derives it from the connection alone, in one place, so the
 * chat surface, the run pipeline and the upgrade prompts cannot disagree:
 *
 * - `free` — the free-only gate actually constrains the run: a hosted
 *   provider, free models, no key needed, slower and queue-bound. This is the
 *   default, and it stays the default (JEV `free-with-upgrade-path`).
 * - `plan` — the run is driven by something paid or unmetered: freeOnly is
 *   off and a key (the person's own, or the deployment's for a managed tier)
 *   or a local model server carries it. Faster models are allowed.
 *
 * A local server (Ollama, vLLM) or an all-free provider with freeOnly on
 * reads as `plan`: the free-only gate is vacuous there — `assertModelAllowed`
 * in lib/ai/endpoint.ts skips exactly those endpoints — so the run is neither
 * throttled nor key-gated, which is the plan side of the distinction.
 *
 * Pure by design, like lib/chat/settings.ts: the pill reads it in the browser
 * and the server reads it for copy, from the same function.
 */
import { allModelsFree } from '../ai/endpoint.ts';
import type { ChatConnection } from './settings.ts';

export type ChatMode = 'free' | 'plan';

/** Which mode this connection runs in. See the module doc for the rule. */
export function chatModeFor(connection: Pick<ChatConnection, 'baseUrl' | 'freeOnly'>): ChatMode {
  if (!connection.freeOnly) return 'plan';
  // freeOnly is on but constrains nothing: nothing is charged, nothing is
  // throttled, and no key is needed. The free tier's slowness does not apply.
  if (allModelsFree(connection.baseUrl)) return 'plan';
  return 'free';
}

/** Plain words for the mode, for the pill and the upgrade prompts. */
export function chatModeLabel(mode: ChatMode): string {
  return mode === 'free' ? 'Free mode' : 'Plan mode';
}
