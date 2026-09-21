import { providerDestination } from '../ai/endpoint.ts';
import { providerFor, secretNameFor } from '../ai/providers.ts';
import type { ChatConnection } from '../chat/settings.ts';
import { clientFetch } from './request.ts';

/** Key storage is a separate step: some providers cannot list models until
 * this succeeds. Never require a model to save the key needed to discover it. */
export async function saveProviderKey(
  connection: ChatConnection,
  value: string,
): Promise<ChatConnection> {
  const key = value.trim();
  if (!key) throw new Error('Paste your provider API key first.');
  const destination = providerDestination(connection.baseUrl);
  if (!destination) throw new Error('This local endpoint does not use an API key.');
  const name = secretNameFor(connection.baseUrl);
  const response = await clientFetch('/api/secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, value: key, destination }),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('Your session expired. Sign in again, then save the key.');
    throw new Error('The key was not saved. Check your connection and try again.');
  }
  return { ...connection, apiKeySecret: name };
}

/** The settings write must finish before the UI reports success. A rejected
 * write propagates so the form keeps the unsaved connection available to retry. */
export async function saveModelConnection(
  draft: ChatConnection,
  key: string,
  onSave: (connection: ChatConnection) => Promise<void> | void,
): Promise<ChatConnection> {
  if (!draft.baseUrl.trim()) throw new Error('Choose a provider or enter its endpoint.');
  if (!draft.model.trim()) throw new Error('Choose a model before saving the connection.');
  // A hosted connection may use a deployment-managed credential. The server
  // owns that entitlement decision; absence of a browser key is not a refusal.
  const preset = providerFor(draft.baseUrl);
  const connection = key.trim() ? await saveProviderKey(draft, key) : draft;
  const next = {
    ...connection,
    baseUrl: connection.baseUrl.trim(),
    model: connection.model.trim(),
    freeOnly: preset && !preset.local && !preset.freeTier ? false : connection.freeOnly,
  };
  await onSave(next);
  return next;
}
