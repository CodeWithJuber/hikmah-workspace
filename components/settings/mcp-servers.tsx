'use client';
/** MCP servers.
 *
 * The screen exists to make one thing visible: what a server is allowed to do
 * and on whose say-so. A server's tool descriptions become part of the prompt,
 * so "trusted" is a real grant and is presented as one rather than as a tick box
 * with no stated consequence.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Server = {
  id: string;
  name: string;
  label: string;
  description?: string;
  notice?: string;
  requires: string[];
  transport: string;
  target: string;
  enabled: boolean;
  trusted: boolean;
  approval: 'auto' | 'ask' | 'deny';
  status: string;
  lastError: string | null;
};

/** What the status word means, rather than the word on its own. */
const STATUS: Record<string, string> = {
  connected: 'Connected on the last run',
  pending: 'Enabled, not yet contacted',
  failed: 'Last connection failed',
  disabled: 'Off',
};

async function send(method: string, body?: object, query = '') {
  const response = await fetch(`/api/mcp-servers${query}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error ?? 'That did not work.');
  return parsed as { servers: Server[] };
}

export function McpServers() {
  const [servers, setServers] = useState<Server[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', config: '' });

  // A counter rather than a callback: the effect owns the fetch, so a reply
  // arriving after this unmounts sets nothing.
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    fetch('/api/mcp-servers')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Could not load MCP servers.');
        return body.servers as Server[];
      })
      .then((next) => {
        if (live) setServers(next);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setServers([]);
        toast.error(error instanceof Error ? error.message : 'Could not load MCP servers.');
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const change = async (method: string, body: object, query = '') => {
    setBusy(true);
    try {
      const { servers: next } = await send(method, method === 'DELETE' ? undefined : body, query);
      setServers(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    let config: unknown;
    try {
      config = JSON.parse(draft.config);
    } catch {
      toast.error('Paste one server entry as JSON, the way a README shows it.');
      return;
    }
    // A pasted `.mcp.json` usually wraps entries in mcpServers; accept both so
    // copying the whole snippet works rather than half of it.
    const entries =
      config && typeof config === 'object' && 'mcpServers' in config
        ? Object.entries((config as { mcpServers: Record<string, unknown> }).mcpServers)
        : [[draft.name, config] as const];

    setBusy(true);
    try {
      let latest;
      for (const [name, entry] of entries) latest = await send('POST', { name, config: entry });
      if (latest) setServers(latest.servers);
      setDraft({ name: '', config: '' });
      setAdding(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add that server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-medium">
            <Plug className="size-4" aria-hidden />
            MCP servers
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Each server&rsquo;s tools become real tools the model can call, named{' '}
            <code>mcp__server__tool</code>. A tool&rsquo;s description is part of the prompt, so a
            server that rewrites one after you approved it has to ask again.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add a server
          </Button>
        )}
      </header>

      {adding && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <Input
              value={draft.name}
              placeholder="my-server"
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Configuration</span>
            <textarea
              className="min-h-28 rounded-md border bg-transparent p-2 font-mono text-xs"
              spellCheck={false}
              value={draft.config}
              placeholder={'{"type":"http","url":"https://example.com/mcp"}'}
              onChange={(event) => setDraft((d) => ({ ...d, config: event.target.value }))}
            />
            <span className="text-xs text-muted-foreground">
              The same entry shape Claude Code, Cursor and VS Code read, so a snippet from any
              server&rsquo;s README works. Credentials go in as <code>{'${NAME}'}</code> and are
              read from a secret saved under <strong>Secrets</strong> with &ldquo;Use with&rdquo;
              set to <strong>MCP server environment</strong> &mdash; never stored here.
            </span>
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {servers === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => (
            <li key={server.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{server.label}</p>
                  <p className="text-muted-foreground">{server.description}</p>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {server.transport} · {server.target}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove ${server.label}`}
                  onClick={() => change('DELETE', {}, `?id=${encodeURIComponent(server.id)}`)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>

              {server.notice && (
                <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
                  {server.notice}
                </p>
              )}
              {server.requires.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Needs a saved secret: {server.requires.join(', ')}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    disabled={busy}
                    onChange={(event) =>
                      change('PATCH', { id: server.id, enabled: event.target.checked })
                    }
                  />
                  Enabled
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={server.trusted}
                    disabled={busy}
                    onChange={(event) =>
                      change('PATCH', { id: server.id, trusted: event.target.checked })
                    }
                  />
                  Trusted
                </label>
                <label className="flex items-center gap-2">
                  Approval
                  <select
                    className="rounded border bg-transparent px-1 py-0.5"
                    value={server.approval}
                    disabled={busy}
                    onChange={(event) =>
                      change('PATCH', { id: server.id, approval: event.target.value })
                    }
                  >
                    <option value="ask">Ask every time</option>
                    <option value="auto">Allow read-only tools</option>
                    <option value="deny">Never run</option>
                  </select>
                </label>
                <span className="text-xs text-muted-foreground">
                  {STATUS[server.status] ?? server.status}
                </span>
              </div>

              <p className="text-xs text-muted-foreground">
                Trusted means this server&rsquo;s own claim that a tool is read-only is believed. An
                untrusted server is asked about every time, whatever it says about itself, and a
                tool that can destroy things or reach the open web always asks.
              </p>

              {server.lastError && (
                <p className="text-xs text-destructive" role="status">
                  {server.lastError}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
