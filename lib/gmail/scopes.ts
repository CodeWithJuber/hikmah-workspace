/** The Gmail scopes this integration asks for, and nothing more.
 *
 * Two separate grants, requested separately, so the owner can read mail for
 * months without ever granting send: `read` asks only for
 * `gmail.readonly`, and `send` asks for `gmail.compose` + `gmail.send`.
 * Google supports incremental authorization, so a later `send` grant merges
 * into the same account row rather than replacing the earlier one.
 *
 * The account row records the scopes Google actually granted (space-joined),
 * and the send path checks them at call time — a stored grant is a claim,
 * the scope check is the enforcement.
 */

export const GMAIL_SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
export const GMAIL_SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send';

/** The two grant kinds the owner can ask for. */
export type GmailGrantKind = 'read' | 'send';

/** The Google scopes one grant kind asks for. */
export function scopesForGrant(kind: GmailGrantKind): string[] {
  return kind === 'read' ? [GMAIL_SCOPE_READONLY] : [GMAIL_SCOPE_COMPOSE, GMAIL_SCOPE_SEND];
}

/** Split a stored scopes string back into its scopes. */
export function parseScopes(stored: string | null | undefined): string[] {
  if (!stored) return [];
  return stored.split(' ').filter((scope) => scope.length > 0);
}

/** Merge newly granted scopes into the stored set: union, stable order. */
export function mergeScopes(stored: string | null | undefined, granted: string[]): string {
  const seen = new Set(parseScopes(stored));
  for (const scope of granted) seen.add(scope);
  return [...seen].sort().join(' ');
}

/** Whether the stored scopes permit reading mail. */
export function canRead(stored: string | null | undefined): boolean {
  return parseScopes(stored).includes(GMAIL_SCOPE_READONLY);
}

/** Whether the stored scopes permit sending mail. Compose implies send. */
export function canSend(stored: string | null | undefined): boolean {
  const scopes = parseScopes(stored);
  return scopes.includes(GMAIL_SCOPE_SEND) || scopes.includes(GMAIL_SCOPE_COMPOSE);
}

/** Human words for the scope badges in the settings screen. */
export function scopeLabels(stored: string | null | undefined): string[] {
  const labels: string[] = [];
  if (canRead(stored)) labels.push('Read mail');
  if (canSend(stored)) labels.push('Send mail');
  return labels;
}
