'use client';
import { useEffect, useId, useState } from 'react';
import { KeyRound, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  SECRET_SERVICES,
  type SecretMetadata,
  mcpSecretDestination,
  validSecretName,
} from '@/lib/playground/secret-reference';
import { usePlayground } from './context';

function useSecrets() {
  const [rows, setRows] = useState<SecretMetadata[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let current: AbortController | undefined;
    const refresh = async () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      try {
        const response = await fetch('/api/secrets', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not load secret variables.');
        if (active && !controller.signal.aborted) {
          setRows(data.secrets);
          setError('');
        }
      } catch (e) {
        if (active && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Could not load secret variables.');
      } finally {
        if (active && !controller.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    window.addEventListener('hikmah-secrets-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      current?.abort();
      window.removeEventListener('hikmah-secrets-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return { rows, error, loading };
}
export function SavedSecretSelect({
  destination,
  value,
  onChange,
  disabled,
  label = 'Saved secret',
}: {
  destination: string;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { rows, error, loading } = useSecrets();
  const id = useId();
  const available = rows.filter((r) => r.destination === destination);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="secret-select"
        value={value ?? ''}
        disabled={disabled || loading}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{loading ? 'Loading…' : 'Use a session key'}</option>
        {value && !available.some((r) => r.name === value) && (
          <option value={value}>{value} · unavailable for this service</option>
        )}
        {available.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
          </option>
        ))}
      </select>
      {error && (
        <p className="small-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function SecretsSettings() {
  const { rows, error, loading } = useSecrets();
  const [name, setName] = useState(''),
    [value, setValue] = useState(''),
    [service, setService] = useState('provider:openrouter'),
    [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failure, setFailure] = useState(''),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState('');
  const reset = () => {
    setName('');
    setValue('');
    setEditing(false);
    setEndpoint('');
  };
  const mutate = async (method: 'PUT' | 'DELETE', variable = name) => {
    if (busy) return;
    setBusy(true);
    setFailure('');
    setMessage('');
    try {
      const response = await fetch(
        '/api/secrets' + (method === 'DELETE' ? '?name=' + encodeURIComponent(variable) : ''),
        {
          method,
          credentials: 'same-origin',
          headers: method === 'PUT' ? { 'Content-Type': 'application/json' } : undefined,
          body:
            method === 'PUT'
              ? JSON.stringify({
                  name: variable,
                  value,
                  destination: service === 'mcp' ? mcpSecretDestination(endpoint) : service,
                })
              : undefined,
          signal: AbortSignal.timeout(15000),
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not save this change.');
      setMessage(
        method === 'PUT'
          ? 'Secret saved. Select its name in the matching connection settings.'
          : 'Secret deleted. Connections using this name need a replacement.',
      );
      if (method === 'PUT' || name === variable) reset();
      setDeleting('');
      window.dispatchEvent(new Event('hikmah-secrets-changed'));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not save this change.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="secrets-settings">
      <div className="settings-section-title">
        <KeyRound size={22} />
        <div>
          <h3>Workspace secrets</h3>
          <p>Save once. Reuse a named variable in your workspace’s connections and tools.</p>
        </div>
      </div>
      <p className="small-note">
        Values are encrypted on the server and scoped to your account. Secret storage is separate
        from chat, files and configuration exports. Values are not added to model prompts. Changing
        a variable updates every connection that uses its name.
      </p>
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void mutate('PUT');
        }}
      >
        <div className="field">
          <label htmlFor="secret-name">Variable name</label>
          <Input
            id="secret-name"
            value={name}
            maxLength={64}
            disabled={editing || busy}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="OPENROUTER_API_KEY"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label htmlFor="secret-service">Use with</label>
          <select
            id="secret-service"
            className="secret-select"
            value={service}
            disabled={busy}
            onChange={(e) => setService(e.target.value)}
          >
            {SECRET_SERVICES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {service === 'mcp' && (
          <div className="field">
            <label htmlFor="secret-endpoint">Exact MCP endpoint</label>
            <Input
              id="secret-endpoint"
              type="url"
              value={endpoint}
              disabled={busy}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://tools.example.com/mcp"
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="secret-value">{editing ? 'Replacement value' : 'Secret value'}</label>
          {service === 'runtime:env' ? (
            <Textarea
              id="secret-value"
              value={value}
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value available to your generated runtime code"
            />
          ) : (
            <Input
              id="secret-value"
              type="password"
              value={value}
              maxLength={8192}
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                editing
                  ? 'Enter a new value; the saved value is never revealed'
                  : 'Paste the credential'
              }
            />
          )}
        </div>
        {service === 'search:brave' && (
          <p className="small-note">
            Name this variable BRAVE_SEARCH_API_KEY to use Brave automatically when a SearXNG
            endpoint is not configured.
          </p>
        )}
        {service === 'runtime' && (
          <p className="small-note">
            Name this variable HIKMAH_RUNTIME_TOKEN. The owner’s runtime uses it automatically with
            the server’s configured runtime endpoint.
          </p>
        )}
        {service === 'runtime:env' && (
          <p className="small-note">
            Grants your generated Python and Node code access through environment variables in the
            owner’s isolated runtime. These values are supplied on each code run; choose this
            service only for variables that code may access. The browser preview and SSH actions do
            not receive them.
          </p>
        )}
        <div className="secret-actions">
          <Button
            type="submit"
            disabled={!validSecretName(name) || !value || busy || (service === 'mcp' && !endpoint)}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{' '}
            {editing ? 'Replace secret' : 'Save secret'}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
              Cancel
            </Button>
          )}
        </div>
      </form>
      {(error || failure) && (
        <p role="alert" className="media-error">
          {failure || error}
        </p>
      )}
      {message && (
        <p role="status" className="small-note">
          {message}
        </p>
      )}
      <div className="secret-list" aria-label="Saved secret variables">
        {loading ? (
          <p role="status">Loading saved variables…</p>
        ) : !rows.length ? (
          <p className="small-note">No secrets saved yet.</p>
        ) : (
          rows.map((row) => (
            <div className="secret-row" key={row.name}>
              <div>
                <strong>{row.name}</strong>
                <p>
                  {SECRET_SERVICES.find((s) => s.value === row.destination)?.label ??
                    row.destination.replace(/^mcp:/, '')}
                </p>
                <small>Updated {new Date(row.updatedAt).toLocaleDateString()}</small>
              </div>
              <div className="secret-actions">
                {deleting === row.name ? (
                  <>
                    <span>Delete this variable?</span>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void mutate('DELETE', row.name)}
                    >
                      Delete
                    </Button>
                    <Button variant="ghost" onClick={() => setDeleting('')}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setName(row.name);
                        setValue('');
                        setEditing(true);
                        setService(row.destination.startsWith('mcp:') ? 'mcp' : row.destination);
                        setEndpoint(
                          row.destination.startsWith('mcp:') ? row.destination.slice(4) : '',
                        );
                        setMessage('');
                      }}
                    >
                      Replace
                    </Button>
                    <Button
                      variant="ghost"
                      className="icon-button"
                      aria-label={'Delete ' + row.name}
                      disabled={busy}
                      onClick={() => setDeleting(row.name)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
