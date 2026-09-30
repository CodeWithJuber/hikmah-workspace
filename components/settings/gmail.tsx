'use client';
/** Gmail.
 *
 * The screen exists to make two things visible: which account every read and
 * send names (there is no default account, so a second mailbox can never
 * silently receive the first one's mail), and exactly what each account was
 * granted. Reading asks for gmail.readonly; sending is a separate grant, is
 * switched off until the owner turns it on, and every send needs a fresh
 * single-use approval bound to the draft's exact content.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, Plug, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';

type Account = {
  id: string;
  email: string;
  displayName: string | null;
  scopes: string;
  scopeLabels: string[];
  canRead: boolean;
  canSend: boolean;
};

type MessageSummary = { id: string; threadId: string };
type ReadMessage = {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
};

type Draft = {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
};

async function call(path: string, init?: RequestInit) {
  const response = await clientFetch(path, init);
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error ?? 'That did not work.');
  return parsed;
}

const jsonInit = (method: string, body?: object): RequestInit => ({
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

export function GmailPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [sendState, setSendState] = useState<{ sendEnabled: boolean; forceOff: boolean } | null>(
    null,
  );
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [openMessage, setOpenMessage] = useState<ReadMessage | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [composing, setComposing] = useState(false);
  const [compose, setCompose] = useState({ to: '', subject: '', body: '' });
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<{
    draftId: string;
    token: string;
    to: string[];
    subject: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A counter rather than a callback: the effect owns the fetch, so a reply
  // arriving after this unmounts sets nothing.
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [accountBody, settingsBody] = await Promise.all([
          call('/api/gmail/accounts'),
          call('/api/gmail/settings'),
        ]);
        if (!live) return;
        const nextAccounts = accountBody.accounts as Account[];
        setAccounts(nextAccounts);
        setSendState(settingsBody as { sendEnabled: boolean; forceOff: boolean });
        // The working account is always one of the connected ones: every read
        // and send names it explicitly, so there is never a silent default.
        setSelectedId((current) =>
          nextAccounts.some((account) => account.id === current)
            ? current
            : (nextAccounts[0]?.id ?? ''),
        );
        setError('');
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Could not load Gmail.');
      }
    })();
    return () => {
      live = false;
    };
  }, [revision]);

  // Landing back from Google's consent screen. The page loaded fresh from the
  // callback redirect, so the effect above already fetched the new account —
  // this only announces the outcome and cleans the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmail = params.get('gmail');
    if (!gmail) return;
    if (gmail === 'connected')
      toast.success(`Connected ${params.get('email') ?? 'your Gmail account'}.`);
    else toast.error('The Google sign-in did not finish. Try connecting again.');
    params.delete('gmail');
    params.delete('email');
    params.delete('reason');
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    (async () => {
      setMessages(null);
      setDrafts(null);
      setOpenMessage(null);
      try {
        const [messageBody, draftBody] = await Promise.all([
          call(`/api/gmail/messages?accountId=${encodeURIComponent(selectedId)}`),
          call(`/api/gmail/drafts?accountId=${encodeURIComponent(selectedId)}`),
        ]);
        if (!live) return;
        setMessages(messageBody.messages as MessageSummary[]);
        setDrafts(draftBody.drafts as Draft[]);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Could not load mail.');
      }
    })();
    return () => {
      live = false;
    };
  }, [selectedId, revision]);

  const searchMessages = async (accountId: string, q: string) => {
    setMessages(null);
    setOpenMessage(null);
    try {
      const body = await call(
        `/api/gmail/messages?accountId=${encodeURIComponent(accountId)}` +
          (q ? `&q=${encodeURIComponent(q)}` : ''),
      );
      setMessages(body.messages as MessageSummary[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read mail.');
    }
  };

  const connect = async (kind: 'read' | 'send', accountId?: string) => {
    setBusy(true);
    try {
      const body = await call('/api/gmail/oauth', jsonInit('POST', { kind, accountId }));
      window.location.assign(body.url as string);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Could not start the Google sign-in.');
    }
  };

  const disconnect = async (account: Account) => {
    setBusy(true);
    try {
      await call(`/api/gmail/accounts?id=${encodeURIComponent(account.id)}`, jsonInit('DELETE'));
      reload();
      toast.success(`Disconnected ${account.email}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const flipSend = async (enabled: boolean) => {
    setBusy(true);
    try {
      const body = await call('/api/gmail/settings', jsonInit('PATCH', { sendEnabled: enabled }));
      setSendState(body as { sendEnabled: boolean; forceOff: boolean });
      toast.success(
        enabled ? 'Sending is on. Every mail still needs its own approval.' : 'Sending is off.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await call(
        '/api/gmail/drafts',
        jsonInit('POST', {
          accountId: selectedId,
          to: compose.to
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          subject: compose.subject,
          body: compose.body,
        }),
      );
      setComposing(false);
      setCompose({ to: '', subject: '', body: '' });
      reload();
      toast.success('Draft saved locally. Nothing was sent.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (draft: Draft) => {
    setApprovingId(draft.id);
    try {
      const body = await call(
        '/api/gmail/send',
        jsonInit('POST', { action: 'approve', draftId: draft.id }),
      );
      setPendingSend({
        draftId: draft.id,
        token: body.approvalToken as string,
        to: draft.to,
        subject: draft.subject,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setApprovingId(null);
    }
  };

  const send = async () => {
    if (!pendingSend) return;
    setBusy(true);
    try {
      const body = await call(
        '/api/gmail/send',
        jsonInit('POST', {
          action: 'send',
          draftId: pendingSend.draftId,
          approvalToken: pendingSend.token,
          idempotencyKey: `ui-${pendingSend.draftId}-${Date.now()}`,
        }),
      );
      setPendingSend(null);
      reload();
      toast.success(body.duplicate ? 'Already sent — the retry returned the first mail.' : 'Sent.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const open = async (accountId: string, id: string) => {
    try {
      const body = await call(
        `/api/gmail/messages?accountId=${encodeURIComponent(accountId)}&id=${encodeURIComponent(id)}`,
      );
      setOpenMessage(body.message as ReadMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the message.');
    }
  };

  const selected = accounts?.find((a) => a.id === selectedId);

  return (
    <section aria-label="Gmail" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className="size-5" aria-hidden />
          <div>
            <h3 className="text-base font-semibold">Gmail</h3>
            <p className="text-sm text-muted-foreground">
              Read mail, keep drafts locally, and send — each with its own explicit permission.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void connect('read')}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            <Plug className="size-4" aria-hidden />
            Connect for reading
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void connect('send')}>
            Connect for reading + sending
          </Button>
        </div>
      </header>

      {error && (
        <p
          className="rounded-md border border-destructive/40 p-2 text-sm text-destructive"
          role="status"
        >
          {error}
        </p>
      )}

      {accounts === null ? (
        <Skeleton className="h-4 w-40" aria-label="Loading Gmail accounts" />
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Gmail account connected. Reading asks Google for read-only access; sending is a
          separate grant you add later, per account.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium break-all">{account.email}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {account.scopeLabels.map((label) => (
                    <span
                      key={label}
                      className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {label}
                    </span>
                  ))}
                  {account.scopeLabels.length === 0 && (
                    <span className="text-xs text-muted-foreground">No permissions granted</span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!account.canSend && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void connect('send', account.id)}
                  >
                    Add send permission
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Disconnect ${account.email}`}
                  onClick={() => void disconnect(account)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-md border p-3 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={sendState?.sendEnabled ?? false}
            disabled={busy || !sendState || sendState.forceOff}
            onChange={(event) => void flipSend(event.target.checked)}
          />
          <span>
            <span className="font-medium">Allow sending mail</span>
            <span className="block text-xs text-muted-foreground">
              Off until you switch it on. Even on, every mail needs its own approval, and an
              approval covers only the exact draft it was given for.
              {sendState?.forceOff &&
                ' The workspace operator has switched sending off deployment-wide.'}
            </span>
          </span>
        </label>
      </div>

      {accounts !== null && accounts.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="text-muted-foreground" htmlFor="gmail-account">
              Account
            </label>
            <select
              id="gmail-account"
              className="rounded border bg-transparent px-2 py-1"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
            {selected && !selected.canRead && (
              <span className="text-xs text-muted-foreground">
                This account can send but not read.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                placeholder="Search mail"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && selectedId) void searchMessages(selectedId, query);
                }}
                aria-label="Search mail"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!selectedId}
                onClick={() => selectedId && void searchMessages(selectedId, query)}
              >
                Search
              </Button>
            </div>
            {messages === null ? (
              <Skeleton className="h-4 w-32" aria-label="Loading messages" />
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages found.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {messages.map((message) => (
                  <li key={message.id}>
                    <button
                      type="button"
                      className="w-full rounded border px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => selectedId && void open(selectedId, message.id)}
                    >
                      <span className="font-mono text-xs text-muted-foreground">{message.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {openMessage && (
              <article className="rounded-md border p-3 text-sm">
                <p className="font-medium">{openMessage.subject || '(no subject)'}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  From {openMessage.from} · To {openMessage.to} · {openMessage.date}
                </p>
                <p className="mt-2 whitespace-pre-wrap">
                  {openMessage.body || openMessage.snippet}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => setOpenMessage(null)}
                >
                  Close
                </Button>
              </article>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Drafts — local until sent</h4>
              <Button size="sm" variant="outline" onClick={() => setComposing((v) => !v)}>
                {composing ? 'Cancel' : 'New draft'}
              </Button>
            </div>
            {composing && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <Input
                  placeholder="To — comma-separated addresses"
                  value={compose.to}
                  onChange={(event) => setCompose((c) => ({ ...c, to: event.target.value }))}
                  aria-label="Recipients"
                />
                <Input
                  placeholder="Subject"
                  value={compose.subject}
                  onChange={(event) => setCompose((c) => ({ ...c, subject: event.target.value }))}
                  aria-label="Subject"
                />
                <textarea
                  className="min-h-24 rounded-md border bg-transparent p-2 text-sm"
                  placeholder="Body"
                  value={compose.body}
                  onChange={(event) => setCompose((c) => ({ ...c, body: event.target.value }))}
                  aria-label="Body"
                />
                <Button
                  size="sm"
                  disabled={busy || !compose.to.trim()}
                  onClick={() => void createDraft()}
                >
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Save draft
                </Button>
              </div>
            )}
            {drafts === null ? (
              <Skeleton className="h-4 w-32" aria-label="Loading drafts" />
            ) : drafts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No drafts.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {drafts.map((draft) => (
                  <li key={draft.id} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">{draft.subject || '(no subject)'}</p>
                    <p className="text-xs text-muted-foreground">To {draft.to.join(', ')}</p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap">{draft.body}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approvingId === draft.id || !sendState?.sendEnabled}
                        onClick={() => void approve(draft)}
                        title={
                          sendState?.sendEnabled
                            ? 'Approve this exact draft for sending'
                            : 'Switch sending on above before approving'
                        }
                      >
                        {approvingId === draft.id && (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        )}
                        Approve to send
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          call(
                            `/api/gmail/drafts?id=${encodeURIComponent(draft.id)}`,
                            jsonInit('DELETE'),
                          )
                            .then(() => reload())
                            .catch((err: unknown) =>
                              toast.error(
                                err instanceof Error ? err.message : 'That did not work.',
                              ),
                            )
                        }
                      >
                        Discard
                      </Button>
                    </div>
                    {pendingSend?.draftId === draft.id && (
                      <div className="mt-2 rounded border border-amber-500/40 p-2" role="alert">
                        <p className="text-xs">
                          Send this mail to <strong>{pendingSend.to.join(', ')}</strong>
                          {pendingSend.subject && (
                            <>
                              {' '}
                              with subject <strong>{pendingSend.subject}</strong>
                            </>
                          )}
                          ? The approval covers only this exact draft and can be used once.
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" disabled={busy} onClick={() => void send()}>
                            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                            Send now
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setPendingSend(null)}>
                            Not yet
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
