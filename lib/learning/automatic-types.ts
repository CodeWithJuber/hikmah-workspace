/** Browser-safe, factual status for the once-enabled learning flow. */
export const AUTOMATIC_DAILY_REQUESTS = 3;
export const AUTOMATIC_SENTENCES_PER_REQUEST = 2;
export const AUTOMATIC_OUTPUT_TOKENS = 3_840;
export const AUTOMATIC_MAX_CORPUS = 200;
export type AutomaticStatus =
  'paused' | 'waiting' | 'preparing' | 'training' | 'evaluating' | 'updated' | 'held' | 'error';
export type AutomaticSnapshot = {
  status: AutomaticStatus;
  reason: string;
  queued: number;
  requestsToday: number;
  dailyLimit: number;
  sentencesPerRequest: number;
  lastAt: string | null;
  language: string | null;
  checkpointId: string | null;
  metric: { scope: string; gain: number; approved: boolean } | null;
};
