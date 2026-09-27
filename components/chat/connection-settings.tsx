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
import { useEffect, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ChatConnection } from '@/lib/chat/settings';
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
import { clientFetch } from '@/lib/client/request';
import { saveModelConnection, saveProviderKey } from '@/lib/client/model-connection';

export function ConnectionSettings({
  connection,
  onChange,
  active = true,
}: {
  connection: ChatConnection;
  onChange: (connection: ChatConnection) => Promise<void> | void;
  active?: boolean;
}) {
  const [draft, setDraft] = useState<ChatConnection>(connection);
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  if (!active && providerOpen) setProviderOpen(false);
  if (!active && reveal) setReveal(false);
  const [busy, setBusy] = useState<'key' | 'connection' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState('');
  const [reload, setReload] = useState(0);
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
  if (seen !== connection) {
    setSeen(connection);
    if (!dirty && !busy) setDraft(connection);
  }

  useEffect(() => {
    let live = true;
    void clientFetch('/api/secrets')
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
  const keySaved = Boolean(draft.apiKeySecret) && saved.has(draft.apiKeySecret);
  /** Whether "free only" means anything here: OpenRouter has free routes and a
   * local server bills nothing; every other hosted provider bills every token. */
  const freeTier = local || !preset || preset.freeTier;
  const catalogueKey = [draft.baseUrl, draft.apiKeySecret, draft.freeOnly, reload].join('\n');
  const keyRequiredForCatalogue = takesKey && !preset?.publicCatalogue && !draft.apiKeySecret;
  const catalogueReady = catalogue.key === catalogueKey;
  const rows = catalogueReady ? catalogue.rows : [];
  const catalogueError = catalogueReady ? catalogue.error : '';

  const edit = (patch: Partial<ChatConnection>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setNote('');
    setFailure('');
  };

  // The catalogue for the draft, loaded through the server. Reloaded when the
  // endpoint or the key changes, so the picker shows what the connection being
  // saved will actually offer.
  useEffect(() => {
    if (!draft.baseUrl.trim() || keyRequiredForCatalogue) return;
    const controller = new AbortController();
    // Editing a custom URL should not send a request for each character.
    const timer = setTimeout(
      () =>
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
            if (controller.signal.aborted) return;
            const usable =
              draft.freeOnly && !allModelsFree(draft.baseUrl)
                ? rows.filter((row) => priceKind(row) === 'free')
                : rows;
            setCatalogue({
              key: catalogueKey,
              rows: usable.map((row) => ({ ...row, label: row.name || row.id })).slice(0, 500),
              error: '',
            });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setCatalogue({
              key: catalogueKey,
              rows: [],
              error:
                error instanceof Error
                  ? error.message
                  : 'Models could not be loaded. Retry, or search using the exact model ID.',
            });
          }),
      250,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.baseUrl, draft.apiKeySecret, draft.freeOnly, catalogueKey, keyRequiredForCatalogue]);
  const catalogueLoading =
    Boolean(draft.baseUrl.trim()) && !keyRequiredForCatalogue && !catalogueReady;

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
    setDirty(true);
    setNote('');
    setFailure('');
  };

  const saveKey = async () => {
    setBusy('key');
    setNote('');
    setFailure('');
    try {
      const next = await saveProviderKey(draft, key);
      setDraft(next);
      setSaved((current) => new Set([...current, next.apiKeySecret]));
      setDirty(true);
      setKey('');
      setReload((value) => value + 1);
      setNote('Key saved. Choose a model, then save the connection.');
      window.dispatchEvent(new Event('hikmah-secrets-changed'));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The key was not saved. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('connection');
    setNote('');
    setFailure('');
    try {
      const next = await saveModelConnection(draft, key, onChange);
      setDraft(next);
      if (next.apiKeySecret) setSaved((current) => new Set([...current, next.apiKeySecret]));
      setDirty(false);
      setKey('');
      setNote('Connection saved. You can return to chat.');
      window.dispatchEvent(new Event('hikmah-secrets-changed'));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Connection not saved. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="chat-connection">
      <div className="chat-setting">
        <label htmlFor="chat-provider">Provider</label>
        {/* The same select as every other one in the product, not the
            browser's own: this was the one native control on the screen, and
            it looked like it belonged to a different app. */}
        <Select
          value={preset ? preset.baseUrl : 'custom'}
          open={active && providerOpen}
          onOpenChange={setProviderOpen}
          disabled={Boolean(busy)}
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
            <SelectItem value="custom">Custom endpoint</SelectItem>
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
            disabled={Boolean(busy)}
            placeholder={OLLAMA_BASE_URL}
            onChange={(event) => edit({ baseUrl: event.target.value, apiKeySecret: '', model: '' })}
          />
          {ollama ? (
            <Collapsible className="chat-settings-disclosure">
              <CollapsibleTrigger className="chat-settings-disclosure-trigger">
                Ollama setup help
              </CollapsibleTrigger>
              <CollapsibleContent>
                <small>
                  The app server connects to Ollama. If it runs in Docker, use{' '}
                  <button
                    type="button"
                    className="chat-inline-link"
                    disabled={Boolean(busy)}
                    onClick={() => edit({ baseUrl: OLLAMA_DOCKER_URL })}
                  >
                    {OLLAMA_DOCKER_URL}
                  </button>{' '}
                  and add <code>host.docker.internal</code> to{' '}
                  <code>HIKMAH_PROVIDER_ALLOW_PRIVATE</code> on the server. Pull a model first (
                  <code>ollama pull llama3.2</code>); installed models appear below.
                </small>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <small>Use the OpenAI-compatible base URL, without /chat/completions.</small>
          )}
        </div>
      )}

      {takesKey && (
        <div className="chat-setting">
          <label htmlFor="chat-key">
            API key{' '}
            {keySaved && (
              <span className="chat-key-saved">
                <Check size={12} aria-hidden="true" /> Saved
              </span>
            )}
          </label>
          <div className="chat-key-row">
            <Input
              id="chat-key"
              type={reveal ? 'text' : 'password'}
              value={key}
              disabled={Boolean(busy)}
              autoComplete="off"
              placeholder={
                keySaved
                  ? `A key is saved for ${preset?.name ?? 'this endpoint'}. Type to replace it.`
                  : `Paste your ${preset?.name ?? 'provider'} key`
              }
              onChange={(event) => {
                setKey(event.target.value);
                setDirty(true);
                setNote('');
                setFailure('');
              }}
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
            Stored encrypted.{' '}
            {keySaved
              ? 'Leave blank to keep your saved key.'
              : 'Your provider bills any paid model usage.'}
            {preset?.keyUrl && (
              <>
                {' '}
                <a href={preset.keyUrl} target="_blank" rel="noreferrer noopener">
                  Get a key <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            )}
          </small>
          {key.trim() && (keyRequiredForCatalogue || !draft.model.trim()) && (
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => void saveKey()}>
              {busy === 'key' && <LoaderCircle size={16} className="spin" />}
              Save key & load models
            </Button>
          )}
        </div>
      )}

      <div className="chat-setting">
        <label htmlFor="chat-model">Model</label>
        <div className="chat-model-row">
          <ModelPicker
            id="chat-model"
            active={active}
            models={rows}
            value={draft.model}
            onSelect={(model) => edit({ model })}
            disabled={Boolean(busy)}
            loading={catalogueLoading}
            error={
              catalogueError ||
              (keyRequiredForCatalogue
                ? 'Save your API key above to load this provider’s models. You can also enter an exact model ID.'
                : '')
            }
            title={`Choose a model on ${preset?.name ?? 'this endpoint'}`}
            local={allModelsFree(draft.baseUrl)}
          />
        </div>
        <small role="status">
          {keyRequiredForCatalogue
            ? 'Save your API key to load available models.'
            : catalogueLoading
              ? 'Loading the catalogue…'
              : rows.length
                ? `${rows.length} models available. Search by name or exact ID.`
                : catalogueError || 'Search by name or enter an exact model ID.'}
        </small>
        {catalogueError && (
          <button
            type="button"
            className="chat-inline-link"
            disabled={Boolean(busy)}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={12} aria-hidden="true" /> Retry loading models
          </button>
        )}
      </div>

      {freeTier && !allModelsFree(draft.baseUrl) ? (
        <Collapsible className="chat-settings-disclosure">
          <CollapsibleTrigger className="chat-settings-disclosure-trigger">
            Model options <span>{draft.freeOnly ? 'Free only' : 'Paid models allowed'}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <label className="chat-setting-toggle">
              <input
                type="checkbox"
                checked={draft.freeOnly}
                disabled={Boolean(busy)}
                onChange={(event) => edit({ freeOnly: event.target.checked })}
              />
              <span>
                Free models only
                <small>
                  Only allow models verified as free. Turn off to use paid models with your key.
                </small>
              </span>
            </label>
          </CollapsibleContent>
        </Collapsible>
      ) : !freeTier ? (
        <p className="chat-connection-note">
          Paid usage is billed by {preset?.name ?? 'your provider'} to your key.
        </p>
      ) : null}

      <div className="chat-connection-actions">
        <Button onClick={() => void save()} disabled={Boolean(busy) || !draft.model.trim()}>
          {busy === 'connection' && <LoaderCircle size={16} className="spin" />}
          Save connection
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            disabled={Boolean(busy)}
            onClick={() => {
              setDraft(connection);
              setKey('');
              setDirty(false);
              setNote('');
              setFailure('');
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
      {failure && (
        <p className="chat-connection-error" role="alert">
          {failure} Your unsaved changes are still here.
        </p>
      )}
      {note && (
        <p className="chat-connection-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
