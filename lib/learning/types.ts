/** Shared, browser-safe learning contract. These are reviewed demonstrations,
 * not a claim that a provider's parameters have changed. */
import type { AutomaticSnapshot } from './automatic-types.ts';
export type LearningPolicy = {
  enabled: boolean;
  automatic: boolean;
  useApproved: boolean;
  collectSyntax: boolean;
  retentionDays: 7 | 30 | 90;
  revision: number;
};

export const DEFAULT_LEARNING_POLICY: LearningPolicy = {
  enabled: false,
  automatic: false,
  useApproved: true,
  collectSyntax: false,
  retentionDays: 30,
  revision: 0,
};

export type LearningConsent = { enabled: boolean; revision: number };
export type ExampleStatus = 'pending' | 'approved' | 'rejected';
export type LearningExample = {
  id: string;
  runId: string;
  conversationId: string;
  model: string;
  provider: string;
  status: ExampleStatus;
  prompt: string;
  response: string;
  correction: string | null;
  effectiveResponse: string;
  redactions: string[];
  createdAt: string;
  reviewedAt: string | null;
  revision: number;
};

export type LearningSnapshot = {
  policy: LearningPolicy;
  counts: Record<ExampleStatus | 'total', number>;
  examples: LearningExample[];
  hasMore: boolean;
  capability: { mode: 'reviewed-examples'; providerWeightsChanged: false };
  automatic: AutomaticSnapshot;
};

export const MAX_PROMPT_CHARACTERS = 12_000;
export const MAX_RESPONSE_CHARACTERS = 24_000;
export const MAX_LEARNING_EXAMPLES = 300;
