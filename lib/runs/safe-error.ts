import { redactLearningText } from '../learning/privacy.ts';

/** Keep actionable provider errors without persisting echoed credentials in
 * the event log, failure row, comparison lane or operator console. */
export function safeDiagnostic(
  error: unknown,
  secrets: readonly string[] = [],
  fallback = 'The run failed.',
): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return redactLearningText(raw || fallback, secrets).text.slice(0, 2000);
}
