'use client';
/** GitHub connection onboarding and the exemplar flow.
 *
 * Onboarding is scoped authorization made visible: the owner ticks the exact
 * fine-grained permissions they granted their token on github.com, pastes the
 * token, and the token is verified before anything is saved. The exemplar
 * then runs read → patch → checks → draft PR, one step at a time, with a
 * receipt for every attempt and an approval card before the only write.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';
import { GITHUB_SCOPES } from '@/lib/github/scopes';

type Connection = {
  id: string;
  label: string;
  scopes: string[];
  status: 'connected' | 'needs-reauth' | 'disabled';
  lastError: string | null;
  createdAt: string;
};

const SCOPE_LABEL: Map<string, (typeof GITHUB_SCOPES)[number]> = new Map(
  GITHUB_SCOPES.map((scope) => [scope.id, scope]),
);

async function send(path: string, method: string, body?: object, query = '') {
  const response = await clientFetch(`${path}${query}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(parsed.error ?? 'That did not work.') as Error & {
      code?: string;
      recovery?: string;
      preserved?: unknown;
      retryable?: boolean;
    };
    failure.code = parsed.code;
    failure.recovery = parsed.recovery;
    failure.preserved = parsed.preserved;
    failure.retryable = parsed.retryable;
    throw failure;
  }
  return parsed;
}

function ConnectForm({ onConnected }: { onConnected: (connections: Connection[]) => void }) {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [scopes, setScopes] = useState<string[]>(['contents:read', 'issues:read']);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setScopes((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const connect = async () => {
    setBusy(true);
    try {
      const parsed = await send('/api/github', 'POST', { label, token, scopes });
      onConnected(parsed.connections as Connection[]);
      setToken('');
      toast.success(parsed.login ? `Connected as ${parsed.login}.` : 'GitHub connected.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border p-4 flex flex-col gap-3">
      <p className="text-sm font-medium">Connect GitHub</p>
      <p className="text-xs text-muted-foreground">
        Create a fine-grained personal access token on GitHub with exactly the permissions you tick
        below — no more. The token is verified before it is saved, and it is stored encrypted, bound
        to this connection.
      </p>
      <ul className="flex flex-col gap-1.5">
        {GITHUB_SCOPES.map((scope) => (
          <li key={scope.id}>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={scopes.includes(scope.id)}
                onChange={() => toggle(scope.id)}
              />
              <span>
                <span className="font-medium">{scope.label}</span>
                <span className="text-muted-foreground"> — {scope.description}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          placeholder="Connection name, e.g. Work GitHub"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-label="Connection name"
        />
        <Input
          type="password"
          placeholder="Paste the token (github_pat_…)"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-label="GitHub token"
          autoComplete="off"
        />
      </div>
      <div>
        <Button size="sm" onClick={connect} disabled={busy || !token.trim()}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="size-3.5" aria-hidden />
          )}
          Connect
        </Button>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<Connection['status'], string> = {
  connected: 'Connected',
  'needs-reauth': 'Needs a fresh token',
  disabled: 'Off',
};

/** The exemplar, one step at a time: read file → read issues → propose patch →
 * surface checks → draft PR. Each step shows its receipt, and the draft-PR
 * step stops at an approval card bound to the exact action. */
function Exemplar({ connection }: { connection: Connection }) {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('README.md');
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; sha: string; content: string } | null>(null);
  const [patch, setPatch] = useState('');
  const [checks, setChecks] = useState<
    { name: string; status?: string; conclusion: string | null }[] | null
  >(null);
  const [failure, setFailure] = useState<{
    step: string;
    message: string;
    recovery?: string;
  } | null>(null);
  const [receipts, setReceipts] = useState<string[]>([]);

  const noteReceipt = useCallback((parsed: { receiptId?: string; dryRun?: boolean }) => {
    if (parsed.receiptId)
      setReceipts((prev) =>
        [`${parsed.receiptId}${parsed.dryRun ? ' · dry run' : ''}`, ...prev].slice(0, 20),
      );
  }, []);

  const runStep = useCallback(
    async (step: string, action: string, params: Record<string, unknown>, extra?: object) => {
      setBusy(step);
      setFailure(null);
      try {
        const parsed = await send('/api/github/flow', 'POST', {
          connectionId: connection.id,
          action,
          params,
          ...(extra ?? {}),
        });
        noteReceipt(parsed);
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'That did not work.';
        const recovery = (error as { recovery?: string }).recovery;
        setFailure({ step, message, recovery });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [connection.id, noteReceipt],
  );

  const readFile = async () => {
    const parsed = await runStep('read', 'read-file', { owner, repo, path });
    if (parsed?.data) setFile(parsed.data);
  };
  const proposePatch = async () => {
    if (!file) return;
    const newContent = `${file.content}\n\n<!-- Touched by the Hikmah GitHub exemplar. -->\n`;
    const parsed = await runStep('patch', 'propose-patch', {
      path: file.path,
      baseContent: file.content,
      newContent,
    });
    if (parsed?.data?.diff) setPatch(parsed.data.diff);
  };
  const surfaceChecks = async () => {
    const parsed = await runStep('checks', 'surface-checks', { owner, repo, ref: 'main' });
    if (parsed?.data?.checks) setChecks(parsed.data.checks);
    if (parsed?.blocked) setChecks(parsed.data.checks ?? []);
  };

  return (
    <div className="rounded border p-4 flex flex-col gap-3">
      <p className="text-sm font-medium">Exemplar flow</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          placeholder="owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          aria-label="Repository owner"
        />
        <Input
          placeholder="repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          aria-label="Repository name"
        />
        <Input
          placeholder="path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          aria-label="File path"
        />
      </div>
      <ol className="flex flex-col gap-2 text-xs">
        <li className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !owner || !repo}
            onClick={readFile}
          >
            {busy === 'read' ? <Loader2 className="size-3.5 animate-spin" /> : null} 1 · Read file
          </Button>
          {file && (
            <span className="text-muted-foreground">
              {file.path} · {file.content.length} chars
            </span>
          )}
        </li>
        <li className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !file}
            onClick={proposePatch}
          >
            {busy === 'patch' ? <Loader2 className="size-3.5 animate-spin" /> : null} 2 · Propose
            patch
          </Button>
          {patch && <span className="text-muted-foreground">diff proposed, nothing pushed</span>}
        </li>
        <li className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !owner || !repo}
            onClick={surfaceChecks}
          >
            {busy === 'checks' ? <Loader2 className="size-3.5 animate-spin" /> : null} 3 · Surface
            checks
          </Button>
          {checks && (
            <span className="text-muted-foreground">
              {checks.length === 0
                ? 'no checks reported'
                : checks.map((c) => `${c.name}: ${c.conclusion ?? c.status ?? '?'}`).join(' · ')}
            </span>
          )}
        </li>
      </ol>
      {patch && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">
            Proposed diff
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
            {patch}
          </pre>
        </details>
      )}
      {failure && (
        <div
          className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs"
          role="alert"
        >
          <p className="font-medium flex items-center gap-1.5">
            <ShieldAlert className="size-3.5" aria-hidden /> {failure.step} failed — nothing was
            lost
          </p>
          <p className="mt-1">{failure.message}</p>
          {failure.recovery && <p className="mt-1 text-muted-foreground">{failure.recovery}</p>}
        </div>
      )}
      {receipts.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Receipts</p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
            {receipts.map((receipt) => (
              <li key={receipt}>{receipt}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The draft-PR step lives behind an approval card in the full workspace flow; it stays a dry
        run until this deployment enables live writes.
      </p>
    </div>
  );
}

export function GithubConnection() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [liveWrites, setLiveWrites] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    send('/api/github', 'GET')
      .then((parsed) => {
        if (!live) return;
        setConnections(parsed.connections as Connection[]);
        setLiveWrites(parsed.liveWritesEnabled === true);
      })
      .catch((error: unknown) => {
        if (!live) return;
        toast.error(error instanceof Error ? error.message : 'Could not load GitHub connections.');
        setConnections([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const disconnect = async (id: string) => {
    setBusyId(id);
    try {
      const parsed = await send(
        '/api/github',
        'DELETE',
        undefined,
        `?id=${encodeURIComponent(id)}`,
      );
      setConnections(parsed.connections as Connection[]);
      if (activeId === id) setActiveId(null);
      toast.success('Disconnected. The token was deleted with it.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Plug className="size-4" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Scoped GitHub access for the exemplar flow. Live writes are{' '}
          <strong>{liveWrites ? 'enabled' : 'disabled'}</strong> on this deployment.
        </p>
      </div>
      {connections === null ? (
        <Skeleton className="h-24 w-full" aria-label="Loading GitHub connections" />
      ) : (
        <>
          {connections.map((connection) => (
            <div key={connection.id} className="rounded border p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{connection.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {STATUS_TEXT[connection.status]}
                    {connection.lastError ? ` — ${connection.lastError}` : ''}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1">
                    {connection.scopes.map((scope) => (
                      <span
                        key={scope}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                        title={SCOPE_LABEL.get(scope)?.description}
                      >
                        {SCOPE_LABEL.get(scope)?.label ?? scope}
                      </span>
                    ))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant={activeId === connection.id ? 'secondary' : 'outline'}
                    onClick={() => setActiveId(activeId === connection.id ? null : connection.id)}
                    disabled={connection.status !== 'connected'}
                  >
                    {activeId === connection.id ? 'Hide exemplar' : 'Run exemplar'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => disconnect(connection.id)}
                    disabled={busyId === connection.id}
                    aria-label={`Disconnect ${connection.label}`}
                  >
                    {busyId === connection.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                  </Button>
                </div>
              </div>
              {activeId === connection.id && <Exemplar connection={connection} />}
            </div>
          ))}
          <ConnectForm onConnected={setConnections} />
        </>
      )}
    </div>
  );
}
