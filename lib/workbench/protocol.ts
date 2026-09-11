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

/** A human-readable reason for a closed socket, for the panel's status line. */
export function closeReason(code: number): string {
  if (code === 1000 || code === 1005) return 'The session ended.';
  if (code === 1006) return 'The connection dropped.';
  if (code === 1008 || code === 1011) return 'The workbench refused the connection.';
  return `The connection closed (${code}).`;
}
