'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, Plug, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { clientFetch } from '@/lib/client/request';
import type {
  TypeformForms,
  TypeformResponses,
  TypeformStatus,
} from '@/lib/integrations/typeform-types';
import styles from './typeform-panel.module.css';

const ENDPOINT = '/api/integrations/typeform';
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await clientFetch(ENDPOINT + path, { cache: 'no-store', ...options });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error || 'Typeform could not be loaded.');
  return payload as T;
}

export function TypeformPanel({
  manage = false,
  embedded = false,
}: {
  manage?: boolean;
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<TypeformStatus | null>(null);
  const [forms, setForms] = useState<TypeformForms | null>(null);
  const [responses, setResponses] = useState<TypeformResponses | null>(null);
  const [selected, setSelected] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const canManage = manage && status?.owner;

  const run = useCallback(async (name: string, work: (signal: AbortSignal) => Promise<void>) => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await work(active.signal);
    } catch (cause) {
      if (!active.signal.aborted && mounted.current)
        setError(cause instanceof Error ? cause.message : 'Typeform is unavailable.');
    } finally {
      if (!active.signal.aborted && mounted.current) setBusy('');
    }
  }, []);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const next = await request<TypeformStatus>('', { signal });
    if (signal.aborted) return;
    setStatus(next);
    setResponses(null);
    setSelected('');
    setForms(null);
    if (next.connected) {
      const result = await request<TypeformForms>('/forms', { signal });
      if (!signal.aborted) setForms(result);
    } else setForms(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const active = new AbortController();
    controller.current = active;
    void Promise.resolve()
      .then(() => refresh(active.signal))
      .catch((cause) => {
        if (!active.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Typeform is unavailable.');
      })
      .finally(() => {
        if (!active.signal.aborted) setBusy('');
      });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [refresh]);

  const mutate = async (action: string, body: Record<string, unknown> = {}) =>
    run(action, async (signal) => {
      const next = await request<TypeformStatus>('', {
        method: action === 'save' ? 'PUT' : action === 'disconnect' ? 'DELETE' : 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'disconnect' ? {} : { body: JSON.stringify({ action, ...body }) }),
      });
      if (signal.aborted) return;
      setStatus(next);
      if (action === 'save' || action === 'disconnect') {
        setToken('');
        setConfirmDisconnect(false);
        await refresh(signal);
      }
      if (action === 'grant') setEmail('');
      if (!signal.aborted)
        setNotice(
          action === 'save'
            ? 'Typeform connected. Choose a form below.'
            : action === 'test'
              ? 'Connection works. Typeform forms are available.'
              : action === 'disconnect'
                ? 'Typeform disconnected. Shared access was removed.'
                : action === 'grant'
                  ? 'Form shared with this account.'
                  : 'Shared access removed.',
        );
    });
  const loadResponses = (formId: string, before?: string) =>
    void run('responses', async (signal) => {
      setSelected(formId);
      setResponses(null);
      const query = new URLSearchParams({ formId, ...(before ? { before } : {}) });
      const result = await request<TypeformResponses>('/responses?' + query, { signal });
      if (!signal.aborted) setResponses(result);
    });
  const loadPage = (page: number) =>
    void run('forms', async (signal) => {
      const result = await request<TypeformForms>('/forms?page=' + page, { signal });
      if (!signal.aborted) {
        setForms(result);
        setResponses(null);
        setSelected('');
      }
    });
  const selectedForm = forms?.items.find((form) => form.id === selected) ?? responses?.form;

  return (
    <section
      className={`${styles.panel} ${embedded ? styles.embedded : ''}`}
      aria-label="Typeform integration"
      aria-busy={Boolean(busy)}
    >
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.mark}>
            <FileText size={24} />
          </span>
          <div>
            <h2>Typeform</h2>
            <p>Turn survey responses into useful answers.</p>
          </div>
        </div>
        {status?.connected && (
          <span className={styles.connected}>
            <span /> Connected
          </span>
        )}
      </header>
      {error && (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          {!busy && (
            <Button variant="outline" onClick={() => void run('loading', refresh)}>
              Try again
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {busy === 'loading' && <p role="status">Loading Typeform…</p>}

      {canManage && (
        <div className={styles.connection}>
          <div className={styles.explanation}>
            <ShieldCheck size={20} />
            <p>Save one token for the platform. You choose which forms each account can read.</p>
          </div>
          {status.connected ? (
            <>
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void mutate('test')}
                >
                  <RefreshCw size={16} />
                  {busy === 'test' ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirmDisconnect(true)}
                >
                  Disconnect
                </Button>
              </div>
              {confirmDisconnect && (
                <div className={styles.confirm}>
                  <p>
                    Disconnect Typeform and remove shared access? Forms and responses in Typeform
                    will stay intact.
                  </p>
                  <div className={styles.actions}>
                    <Button
                      variant="destructive"
                      disabled={Boolean(busy)}
                      onClick={() => void mutate('disconnect')}
                    >
                      Disconnect Typeform
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
                      Keep connected
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : null}
          <details open={!status.connected} className={styles.details}>
            <summary>
              {status.connected ? 'Replace token' : 'Connect your Typeform account'}
            </summary>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                void mutate('save', { token });
              }}
            >
              <label htmlFor="typeform-token">Personal access token</label>
              <Input
                id="typeform-token"
                type="password"
                value={token}
                maxLength={8192}
                autoComplete="new-password"
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste your Typeform token"
                required
                disabled={Boolean(busy)}
              />
              <p className={styles.hint}>
                Use <code>forms:read</code> and <code>responses:read</code> scopes. The token stays
                encrypted on the server. A new token removes existing form sharing.
              </p>
              <div className={styles.actions}>
                <Button type="submit" disabled={Boolean(busy) || !token.trim()}>
                  <Plug size={16} />
                  {busy === 'save' ? 'Connecting…' : 'Connect Typeform'}
                </Button>
                <a
                  href="https://admin.typeform.com/account#/section/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get a token <ExternalLink size={12} />
                </a>
              </div>
            </form>
          </details>
          {Boolean(status.grants?.length) && (
            <details className={styles.details}>
              <summary>Shared access · {status.grants?.length}</summary>
              {status.grants?.map((grant) => (
                <div className={styles.grant} key={grant.userId + ':' + grant.formId}>
                  <span>
                    <strong>{grant.title}</strong>
                    <br />
                    {grant.email}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void mutate('revoke', { formId: grant.formId, userId: grant.userId })
                    }
                  >
                    Remove access
                  </Button>
                </div>
              ))}
            </details>
          )}
        </div>
      )}

      {status && !status.connected && !canManage && (
        <div className={styles.empty}>
          <FileText size={32} />
          <h3>No forms shared yet</h3>
          <p>
            {status.owner
              ? 'Connect your Typeform account to browse forms and read responses here.'
              : 'Ask the workspace owner to share a Typeform form with your account.'}
          </p>
          {status.owner && <a href="/superadmin/integrations">Connect Typeform</a>}
        </div>
      )}
      {status?.connected && (
        <>
          {!manage && status.owner && (
            <a className={styles.manageLink} href="/superadmin/integrations">
              Manage connection and sharing
            </a>
          )}
          <div className={styles.browser}>
            <div className={styles.formList}>
              <div className={styles.listHeader}>
                <h3>Your forms</h3>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh forms"
                  disabled={Boolean(busy)}
                  onClick={() => loadPage(forms?.page ?? 1)}
                >
                  <RefreshCw size={16} />
                </Button>
              </div>
              {forms?.items.length === 0 && (
                <p className={styles.hint}>
                  No forms on this page. Create a form in Typeform or check your token’s access.
                </p>
              )}
              {forms?.items.map((form) => (
                <button
                  className={styles.formItem}
                  key={form.id}
                  type="button"
                  disabled={Boolean(busy)}
                  aria-pressed={selected === form.id}
                  onClick={() => loadResponses(form.id)}
                >
                  <FileText size={16} />
                  <span>
                    <strong>{form.title}</strong>
                    <small>{form.id}</small>
                  </span>
                </button>
              ))}
              {forms && forms.pageCount > 1 && (
                <div className={styles.pagination}>
                  <Button
                    variant="outline"
                    disabled={Boolean(busy) || forms.page <= 1}
                    onClick={() => loadPage(forms.page - 1)}
                  >
                    Previous
                  </Button>
                  <span>
                    {forms.page} / {forms.pageCount}
                  </span>
                  <Button
                    variant="outline"
                    disabled={Boolean(busy) || forms.page >= forms.pageCount}
                    onClick={() => loadPage(forms.page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
            <div className={styles.results}>
              {!selected && (
                <div className={styles.empty}>
                  <FileText size={32} />
                  <h3>Choose a form</h3>
                  <p>
                    Review answers here, or ask Hikmah to find patterns in your Typeform responses.
                  </p>
                </div>
              )}
              {busy === 'responses' && <p role="status">Reading responses…</p>}
              {responses && (
                <>
                  <div className={styles.listHeader}>
                    <div>
                      <h3>{responses.form.title}</h3>
                      <p className={styles.hint}>
                        {responses.items.length} responses on this page · {responses.total} in this
                        result
                      </p>
                    </div>
                    {responses.form.url && (
                      <a
                        href={responses.form.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open this form in Typeform"
                      >
                        <ExternalLink size={20} />
                      </a>
                    )}
                  </div>
                  <p className={styles.hint}>{responses.note}</p>
                  <p className={styles.chatHint}>
                    In chat, ask “Summarize responses to {responses.form.title}.” Hikmah asks before
                    sending answers to your selected model.
                  </p>
                  {responses.items.length === 0 && (
                    <p className={styles.hint}>No completed responses found on this page.</p>
                  )}
                  <div className={styles.responseList}>
                    {responses.items.map((row, index) => (
                      <details className={styles.response} key={row.id || index}>
                        <summary>
                          Response {index + 1}
                          <span>
                            {row.submittedAt
                              ? new Date(row.submittedAt).toLocaleString()
                              : 'Submission date unavailable'}
                          </span>
                        </summary>
                        <dl>
                          {row.answers.map((answer, i) => (
                            <div key={i}>
                              <dt>{answer.question}</dt>
                              <dd>{answer.value || 'No answer'}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    ))}
                  </div>
                  <div className={styles.actions}>
                    <Button
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => loadResponses(responses.form.id)}
                    >
                      Latest responses
                    </Button>
                    {responses.nextBefore && (
                      <Button
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          loadResponses(responses.form.id, responses.nextBefore ?? undefined)
                        }
                      >
                        Older responses
                      </Button>
                    )}
                  </div>
                </>
              )}
              {canManage && selectedForm && (
                <details className={styles.sharing}>
                  <summary>Share this form with an account</summary>
                  <p className={styles.hint}>
                    This grants read access to the form and all its responses. Each person still
                    approves using answers in chat.
                  </p>
                  <form
                    className={styles.form}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate('grant', { formId: selectedForm.id, email });
                    }}
                  >
                    <label htmlFor="typeform-share-email">Hikmah account email</label>
                    <Input
                      id="typeform-share-email"
                      type="email"
                      value={email}
                      maxLength={254}
                      required
                      disabled={Boolean(busy)}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com"
                    />
                    <Button type="submit" disabled={Boolean(busy) || !email.trim()}>
                      Share form
                    </Button>
                  </form>
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
