'use client';
/** Which provider this owner's runs talk to, and the key that pays for them.
 *
 * This did not exist, and its absence was the whole first-run failure: the
 * chat read a connection out of the old workspace blob, found none, fell back
 * to a free-only default with no key, and the run died against the provider.
 * The only place to set a key was a dialog on another route.
 *
 * The key never travels back to the browser. It is written to the encrypted
 * vault under a fixed name and the connection only records that name, so
 * reopening this panel shows that a key is saved without ever revealing it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEFAULT_CONNECTION, type ChatConnection } from '@/lib/chat/settings';

/** One secret per owner for the chat's own provider key. A fixed name because
 * the owner is choosing a provider here, not managing a keyring. */
const SECRET_NAME = 'CHAT_PROVIDER_KEY';

/** The providers whose keys the vault can hold. Anything else is a custom or
 * local endpoint, which needs no key and gets none. */
const PRESETS = [
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Experiential Labs', baseUrl: 'https://api.experientiallabs.ai/v1' },
];

export function ConnectionSettings({
  connection,
  onChange,
}: {
  connection: ChatConnection;
  onChange: (connection: ChatConnection) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<ChatConnection>(connection);
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // Reset when the stored settings arrive or change underneath, but never
  // while the owner is mid-edit — that would eat what they were typing.
  const [seen, setSeen] = useState(connection);
  if (seen !== connection && !busy) {
    setSeen(connection);
    setDraft(connection);
  }

  const known = PRESETS.some((preset) => preset.baseUrl === draft.baseUrl);

  const save = useCallback(async () => {
    setBusy(true);
    setNote('');
    try {
      let apiKeySecret = draft.apiKeySecret;
      const typed = key.trim();
      if (typed) {
        const response = await fetch('/api/secrets', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: SECRET_NAME,
            value: typed,
            destination:
              'provider:' +
              (draft.baseUrl.includes('experientiallabs') ? 'experiential' : 'openrouter'),
          }),
        });
        if (!response.ok) throw new Error('The key could not be saved.');
        apiKeySecret = SECRET_NAME;
      }
      await onChange({ ...draft, apiKeySecret });
      setKey('');
      setNote('Saved. Applies from your next message.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [draft, key, onChange]);

  return (
    <section className="chat-connection">
      <div className="chat-setting">
        <label htmlFor="chat-provider">Provider</label>
        <select
          id="chat-provider"
          value={known ? draft.baseUrl : 'custom'}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              baseUrl: event.target.value === 'custom' ? '' : event.target.value,
            }))
          }
        >
          {PRESETS.map((preset) => (
            <option key={preset.baseUrl} value={preset.baseUrl}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Something else</option>
        </select>
      </div>

      {!known && (
        <div className="chat-setting">
          <label htmlFor="chat-base-url">Endpoint</label>
          <Input
            id="chat-base-url"
            value={draft.baseUrl}
            placeholder="http://127.0.0.1:11434/v1"
            onChange={(event) =>
              setDraft((current) => ({ ...current, baseUrl: event.target.value }))
            }
          />
          <small>
            An OpenAI-compatible endpoint. A local one needs no key; a hosted one keeps its key
            somewhere this panel cannot reach.
          </small>
        </div>
      )}

      <div className="chat-setting">
        <label htmlFor="chat-model">Model</label>
        <Input
          id="chat-model"
          value={draft.model}
          placeholder="deepseek/deepseek-chat:free"
          onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
        />
        <small>The provider&rsquo;s own id for the model, copied exactly.</small>
      </div>

      {known && (
        <div className="chat-setting">
          <label htmlFor="chat-key">API key</label>
          <div className="chat-key-row">
            <Input
              id="chat-key"
              type={reveal ? 'text' : 'password'}
              value={key}
              autoComplete="off"
              placeholder={draft.apiKeySecret ? 'A key is saved. Type to replace it.' : 'sk-or-…'}
              onChange={(event) => setKey(event.target.value)}
            />
            <button
              type="button"
              aria-label={reveal ? 'Hide the key' : 'Show the key'}
              onClick={() => setReveal((on) => !on)}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <small>
            Encrypted before it is stored and never sent back to this page. Leave it blank to keep
            the key you already saved.
          </small>
        </div>
      )}

      <label className="chat-setting-toggle">
        <input
          type="checkbox"
          checked={draft.freeOnly}
          onChange={(event) =>
            setDraft((current) => ({ ...current, freeOnly: event.target.checked }))
          }
        />
        <span>
          Free models only
          <small>
            Refuses any model the catalogue does not price at zero, so a run cannot spend.
          </small>
        </span>
      </label>

      <div className="chat-connection-actions">
        <Button onClick={() => void save()} disabled={busy}>
          {busy && <LoaderCircle size={15} className="spin" />}
          Save connection
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(DEFAULT_CONNECTION);
            setKey('');
          }}
        >
          Reset
        </Button>
      </div>
      {note && (
        <p className="chat-connection-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
