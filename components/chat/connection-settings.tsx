'use client';
/** Which provider this owner's runs talk to, and the key that pays for them.
 *
 * This did not exist, and its absence was the whole first-run failure: the
 * chat read a connection out of the old workspace blob, found none, fell back
 * to a free-only default with no key, and the run died against the provider.
 * The only place to set a key was a dialog on another route.
 *
 * The providers come from one registry (`lib/ai/providers.ts`), which the
 * relay and the model factory read too. Each provider keeps its own key in
 * the vault under its own name, so a person with an OpenRouter key and an
 * Anthropic key keeps both and switches between them. The key never travels
 * back to the browser: the connection only records the name it is under.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_CONNECTION, type ChatConnection } from '@/lib/chat/settings';
import { allModelsFree, isLocalEndpoint, providerDestination } from '@/lib/ai/endpoint';
import {
  OLLAMA_BASE_URL,
  OLLAMA_DOCKER_URL,
  PROVIDERS,
  providerFor,
  secretNameFor,
} from '@/lib/ai/providers';
import { listModels } from '@/lib/playground/transport';
import { defaultProvider } from '@/lib/playground/session';
import { priceKind } from '@/lib/playground/model-catalog';
import { ModelPicker, type PickerModel } from './model-picker';

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
  // Which keys the vault already holds, by name, so switching provider picks
  // up the key saved for it rather than forgetting it.
  const [saved, setSaved] = useState<Set<string>>(new Set());
  // The catalogue, and which draft it was loaded for: "loading" is the draft
  // having moved on from that, not a flag an effect has to set.
  const [catalogue, setCatalogue] = useState<{ key: string; rows: PickerModel[]; error: string }>({
    key: '',
    rows: [],
    error: '',
  });

  // Reset when the stored settings arrive or change underneath, but never
  // while the owner is mid-edit — that would eat what they were typing.
  const [seen, setSeen] = useState(connection);
  if (seen !== connection && !busy) {
    setSeen(connection);
    setDraft(connection);
  }

  useEffect(() => {
    let live = true;
    void fetch('/api/secrets', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { secrets: [] }))
      .then((payload: { secrets?: { name: string }[] }) => {
        if (live) setSaved(new Set((payload.secrets ?? []).map((secret) => secret.name)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const preset = providerFor(draft.baseUrl);
  const local = isLocalEndpoint(draft.baseUrl);
  const ollama = preset?.id === 'ollama' || /:11434(\/|$)/.test(draft.baseUrl);
  /** Anything the vault can hold a credential for: the hosted presets and any
   * HTTPS endpoint. A loopback or private address is reached without one. */
  const destination = providerDestination(draft.baseUrl);
  const takesKey = Boolean(destination);
  const secretName = secretNameFor(draft.baseUrl);
  const keySaved = Boolean(draft.apiKeySecret) && saved.has(draft.apiKeySecret);
  /** Whether "free only" means anything here: OpenRouter has free routes and a
   * local server bills nothing; every other hosted provider bills every token. */
  const freeTier = local || !preset || preset.freeTier;

  // The catalogue for the draft, loaded through the server. Reloaded when the
  // endpoint or the key changes, so the picker shows what the connection being
  // saved will actually offer.
  useEffect(() => {
    const key = [draft.baseUrl, draft.apiKeySecret, draft.freeOnly].join('\n');
    if (!draft.baseUrl.trim()) return;
    const controller = new AbortController();
    void listModels(
      {
        ...defaultProvider,
        baseUrl: draft.baseUrl,
        model: '',
        apiKeySecret: draft.apiKeySecret,
        freeOnly: draft.freeOnly,
      },
      controller.signal,
    )
      .then((rows) => {
        const usable =
          draft.freeOnly && !allModelsFree(draft.baseUrl)
            ? rows.filter((row) => priceKind(row) === 'free')
            : rows;
        setCatalogue({
          key,
          rows: usable.map((row) => ({ ...row, label: row.name || row.id })).slice(0, 500),
          error: '',
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogue({
          key,
          rows: [],
          error:
            takesKey && !draft.apiKeySecret
              ? 'Save a key first: this provider lists its models only to a key.'
              : error instanceof Error
                ? error.message
                : 'The catalogue could not be loaded.',
        });
      });
    return () => controller.abort();
  }, [draft.baseUrl, draft.apiKeySecret, draft.freeOnly, local, takesKey]);
  const catalogueLoading =
    Boolean(draft.baseUrl.trim()) &&
    catalogue.key !== [draft.baseUrl, draft.apiKeySecret, draft.freeOnly].join('\n');

  const choose = (baseUrl: string) => {
    const next = providerFor(baseUrl);
    const name = secretNameFor(baseUrl);
    setDraft((current) => ({
      ...current,
      baseUrl,
      // A model id belongs to the provider it came from.
      model: current.baseUrl === baseUrl ? current.model : '',
      // The key saved for this provider, if there is one; never another's.
      apiKeySecret: saved.has(name) ? name : '',
      // No free tier to insist on: every model there is billed.
      freeOnly: next && !next.local && !next.freeTier ? false : current.freeOnly,
    }));
    setKey('');
  };

  const save = useCallback(async () => {
    setBusy(true);
    setNote('');
    try {
      let apiKeySecret = draft.apiKeySecret;
      const typed = key.trim();
      if (typed && !destination)
        throw new Error(
          'That endpoint needs no key. A local or private address is reached direct.',
        );
      if (typed) {
        const response = await fetch('/api/secrets', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: secretName,
            value: typed,
            // The same function the run route resolves against, so what is
            // saved here is what is looked up there.
            destination,
          }),
        });
        if (!response.ok) throw new Error('The key could not be saved.');
        apiKeySecret = secretName;
        setSaved((current) => new Set([...current, secretName]));
      }
      if (!draft.model.trim()) throw new Error('Choose a model, or type its id.');
      await onChange({ ...draft, apiKeySecret, freeOnly: freeTier ? draft.freeOnly : false });
      setKey('');
      setNote('Saved. Applies from your next message.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [draft, key, onChange, destination, secretName, freeTier]);

  return (
    <section className="chat-connection">
      <div className="chat-setting">
        <label htmlFor="chat-provider">Provider</label>
        {/* The same select as every other one in the product, not the
            browser's own: this was the one native control on the screen, and
            it looked like it belonged to a different app. */}
        <Select
          value={preset ? preset.baseUrl : 'custom'}
          onValueChange={(next) => choose(next === 'custom' ? '' : next)}
        >
          <SelectTrigger id="chat-provider" aria-label="Provider">
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((entry) => (
              <SelectItem key={entry.id} value={entry.baseUrl}>
                {entry.name}
              </SelectItem>
            ))}
            <SelectItem value="custom">Something else (OpenAI-compatible)</SelectItem>
          </SelectContent>
        </Select>
        {preset?.note && <small>{preset.note}</small>}
      </div>

      {(!preset || preset.local) && (
        <div className="chat-setting">
          <label htmlFor="chat-base-url">Endpoint</label>
          <Input
            id="chat-base-url"
            value={draft.baseUrl}
            placeholder={OLLAMA_BASE_URL}
            onChange={(event) =>
              setDraft((current) => ({ ...current, baseUrl: event.target.value }))
            }
          />
          {ollama ? (
            <small>
              Ollama on the same machine as the app, reached by the app — not by this browser. If
              the app runs in Docker and Ollama on the host, use{' '}
              <button
                type="button"
                className="chat-inline-link"
                onClick={() => setDraft((current) => ({ ...current, baseUrl: OLLAMA_DOCKER_URL }))}
              >
                {OLLAMA_DOCKER_URL}
              </button>{' '}
              and add <code>host.docker.internal</code> to{' '}
              <code>HIKMAH_PROVIDER_ALLOW_PRIVATE</code> on the server. Pull a model first (
              <code>ollama pull llama3.2</code>); the list below fills from what is installed.
            </small>
          ) : (
            <small>
              An OpenAI-compatible endpoint. A local one needs no key; a hosted one keeps its key
              here, encrypted, like the rest.
            </small>
          )}
        </div>
      )}

      {takesKey && (
        <div className="chat-setting">
          <label htmlFor="chat-key">API key</label>
          <div className="chat-key-row">
            <Input
              id="chat-key"
              type={reveal ? 'text' : 'password'}
              value={key}
              autoComplete="off"
              placeholder={
                keySaved
                  ? `A key is saved for ${preset?.name ?? 'this endpoint'}. Type to replace it.`
                  : `Paste your ${preset?.name ?? 'provider'} key`
              }
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
            {preset?.keyUrl && (
              <>
                {' '}
                <a href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
                  Get a key <ExternalLink size={11} aria-hidden="true" />
                </a>
              </>
            )}
          </small>
        </div>
      )}

      <div className="chat-setting">
        <label htmlFor="chat-model">Model</label>
        <div className="chat-model-row">
          <ModelPicker
            models={catalogue.rows}
            value={draft.model}
            onSelect={(model) => setDraft((current) => ({ ...current, model }))}
            loading={catalogueLoading}
            error={catalogue.error}
            title={`Choose a model on ${preset?.name ?? 'this endpoint'}`}
            local={allModelsFree(draft.baseUrl)}
          />
          <Input
            id="chat-model"
            value={draft.model}
            placeholder={ollama ? 'llama3.2' : 'or type the exact id'}
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
          />
        </div>
        <small>
          {catalogueLoading
            ? 'Loading the catalogue…'
            : catalogue.rows.length
              ? `${catalogue.rows.length} models listed, with prices where the provider or OpenRouter publishes them.`
              : catalogue.error || 'The provider’s own id for the model, copied exactly.'}
        </small>
      </div>

      {freeTier ? (
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
              Refuses any model the catalogue does not price at zero, so a run cannot spend. A local
              server counts as free.
            </small>
          </span>
        </label>
      ) : (
        <p className="chat-connection-note">
          Every model on {preset?.name ?? 'this provider'} is billed to your key. The receipt under
          each answer shows what it cost at the listed rates.
        </p>
      )}

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
