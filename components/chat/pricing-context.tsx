'use client';
/** What the picker knows about each model, for the receipt under an answer.
 *
 * The receipt sits inside every message and the catalogue is loaded once by
 * the chat, so the two meet through a context rather than a prop threaded
 * through five components. Empty means no prices: the receipt then shows
 * tokens and nothing about money, as it always did.
 */
import { createContext, useContext } from 'react';
import type { ModelInfo } from '@/lib/playground/model-catalog';

export const PricingContext = createContext<ReadonlyMap<string, ModelInfo>>(new Map());

export function usePricing(): ReadonlyMap<string, ModelInfo> {
  return useContext(PricingContext);
}
