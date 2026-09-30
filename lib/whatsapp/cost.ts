/** Planning cost table for WhatsApp messages.
 *
 * These are PLANNING estimates in USD, not Meta's real rate card — Meta
 * prices template messages per country and category, and those numbers
 * change. What this table is honest about: which messages are expected to
 * cost money at all. User-initiated conversations inside the 24h session
 * window are free; business-initiated template messages are the paid kind.
 * Estimates live here so every send receipt can carry a bounded,
 * explainable number, and so the settings screen can show spend before any
 * real billing exists.
 */

export type MessageKind = 'session' | 'template';
export type CostedType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'interactive';

/**
 * Estimated USD per outbound message, by kind and type. Session messages
 * cost nothing inside the window; a template is the billable unit.
 */
export const MESSAGE_COST_USD: Record<MessageKind, Record<CostedType, number>> = {
  session: {
    text: 0,
    image: 0,
    audio: 0,
    video: 0,
    document: 0,
    sticker: 0,
    location: 0,
    contacts: 0,
    interactive: 0,
  },
  template: {
    text: 0.01,
    image: 0.02,
    audio: 0.02,
    video: 0.03,
    document: 0.02,
    sticker: 0.01,
    location: 0.01,
    contacts: 0.01,
    interactive: 0.02,
  },
};

/** The most a single message can cost under this table. */
export const MAX_MESSAGE_COST_USD = Math.max(
  ...Object.values(MESSAGE_COST_USD).flatMap((row) => Object.values(row)),
);

function isCostedType(type: string): type is CostedType {
  return type in MESSAGE_COST_USD.template;
}

/** Estimate the cost of one outbound message; unknown types cost nothing. */
export function estimateCost(args: { kind: MessageKind; type: string }): number {
  const { kind, type } = args;
  if (!isCostedType(type)) return 0;
  return MESSAGE_COST_USD[kind][type];
}

/** Sum cost_estimate over message rows, bounded and rounded to cents. */
export function totalSpend(rows: { cost_estimate: number }[]): number {
  const total = rows.reduce((sum, row) => sum + (Number(row.cost_estimate) || 0), 0);
  return Math.round(total * 100) / 100;
}
