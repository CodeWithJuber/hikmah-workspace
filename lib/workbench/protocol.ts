/** The frames a terminal socket carries, in one place.
 *
 * Keystrokes are binary frames and control frames are JSON text. Splitting them
 * by frame type rather than by content means a JSON document pasted into the
 * shell can never be mistaken for an instruction to the workbench — a mistake
 * that would be invisible until someone pasted the wrong file.
 */

export type ControlFrame = { type: 'resize'; cols: number; rows: number };

/** Serialise a control frame. Sent as text. */
export function controlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** Encode keystrokes. Sent as binary, which is what marks them as input. */
export function encodeInput(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Why a session that was running has ended, for the panel's status line. */
export function closeReason(code: number): string {
  if (code === 1000 || code === 1005) return 'The session ended.';
  if (code === 1006) return 'The connection dropped.';
  if (code === 1008 || code === 1011) return 'The workbench refused the connection.';
  return `The connection closed (${code}).`;
}

/** Why a session never started.
 *
 * A different question from closeReason, and it used to be answered with that
 * one's words. A browser will not tell a page why a handshake failed — every
 * refusal arrives as 1006 with no status — so the honest answer names what it
 * could have been rather than inventing one cause, and points at the log that
 * does know.
 */
export function refusedReason(code: number): string {
  if (code === 1006 || code === 1005)
    return 'The terminal could not connect. The workbench may be down, or refusing this origin.';
  if (code === 1008 || code === 1011) return 'The workbench refused the connection.';
  return `The terminal could not connect (${code}).`;
}
