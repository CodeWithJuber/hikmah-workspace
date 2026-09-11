'use client';
/** Saved SSH hosts.
 *
 * Adding one is three steps, and the middle step is the point of the screen:
 * the fingerprint is shown and nothing is trusted until the owner says it is
 * right. Pinning automatically would record whatever answered the connection,
 * which is exactly what a machine-in-the-middle wants.
 */
import { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Loader2, Plus, ServerCog, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Host = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: 'key' | 'password';
  fingerprint: string | null;
  autoApprove: string[];
  lastUsedAt: string | null;
};

type Draft = {
  name: string;
  host: string;
  port: string;
  username: string;
  authKind: 'key' | 'password';
  credential: string;
  autoApprove: string;
};

const blank: Draft = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authKind: 'key',
  credential: '',
  autoApprove: '',
};

/** Grouped into bytes, the way ssh-keygen prints one, so it can be compared. */
function readable(fingerprint: string): string {
  return (fingerprint.match(/.{1,2}/g) ?? []).join(':');
}

async function send(body: object) {
  const response = await fetch('/api/ssh-hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error ?? 'That did not work.');
  return parsed;
}

export function SshHosts() {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [form, setForm] = useState({ ...blank });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The host whose key is being confirmed, and what it presented. */
  const [pending, setPending] = useState<{ host: Host; fingerprint: string } | null>(null);

  // A counter rather than a callback: every write bumps it, and the effect owns
  // the fetch, so a reply that arrives after this unmounts sets nothing.
  const [revision, setRevision] = useState(0);
  const load = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let live = true;
    fetch('/api/ssh-hosts')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Could not load saved hosts.');
        return body.hosts as Host[];
      })
      .then((next) => {
        if (live) setHosts(next);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setHosts([]);
        toast.error(error instanceof Error ? error.message : 'Could not load saved hosts.');
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const save = async () => {
    setBusy(true);
    try {
      const { host } = await send({
        ...form,
        port: Number(form.port),
        autoApprove: form.autoApprove
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      });
      setForm({ ...blank });
      setAdding(false);
      load();
      // Straight into the handshake: a saved host that has never connected is
      // not yet usable, and finding that out later is worse.
      const probe = await send({ id: host.id, action: 'probe' });
      setPending({ host, fingerprint: probe.fingerprint });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save that host.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await send({ id: pending.host.id, action: 'confirm', fingerprint: pending.fingerprint });
      setPending(null);
      load();
      toast.success('Host key pinned. Later changes to it will refuse the connection.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not pin that host key.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (host: Host) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/ssh-hosts?id=${encodeURIComponent(host.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error((await response.json()).error);
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove that host.');
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof Draft, label: string, props = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input
        value={form[key] as string}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        {...props}
      />
    </label>
  );

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-medium">
            <ServerCog className="size-4" aria-hidden />
            Saved servers
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            The assistant can run commands on these over SSH, and on nothing else. It names a server
            from this list; it cannot supply a hostname, a port, a username or a key. Anything you
            have not pre-approved pauses for you.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add a server
          </Button>
        )}
      </header>

      {pending && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Fingerprint className="size-4" aria-hidden />
            Is this {pending.host.name}&rsquo;s host key?
          </p>
          <p className="mt-1 text-muted-foreground">
            Compare it with what the server reports, then confirm. On the server:{' '}
            <code className="text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>. Once
            pinned, a later change to this key refuses the connection instead of warning.
          </p>
          <p className="mt-2 font-mono text-xs break-all" data-testid="fingerprint">
            SHA256 {readable(pending.fingerprint)}
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={confirm} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Yes, pin this key
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void remove(pending.host);
                setPending(null);
              }}
            >
              No, remove the server
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
          {field('name', 'Name')}
          {field('host', 'Hostname or IP', { placeholder: 'server.example.com' })}
          {field('username', 'Username')}
          {field('port', 'Port', { inputMode: 'numeric' })}
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-muted-foreground">
              {form.authKind === 'key' ? 'Private key' : 'Password'}
            </span>
            <textarea
              className="min-h-24 rounded-md border bg-transparent p-2 font-mono text-xs"
              value={form.credential}
              spellCheck={false}
              onChange={(event) =>
                setForm((current) => ({ ...current, credential: event.target.value }))
              }
              placeholder={
                form.authKind === 'key' ? '-----BEGIN OPENSSH PRIVATE KEY-----' : undefined
              }
            />
            <span className="text-xs text-muted-foreground">
              Encrypted with your workspace key and bound to this server. It is sent to the
              workbench for one command at a time and never to the model.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.authKind === 'password'}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  authKind: event.target.checked ? 'password' : 'key',
                }))
              }
            />
            Use a password instead of a private key
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-muted-foreground">
              Commands that may run without asking (one per line, optional)
            </span>
            <textarea
              className="min-h-16 rounded-md border bg-transparent p-2 font-mono text-xs"
              value={form.autoApprove}
              spellCheck={false}
              placeholder={'uptime\ndf -h\nsystemctl status *'}
              onChange={(event) =>
                setForm((current) => ({ ...current, autoApprove: event.target.value }))
              }
            />
            <span className="text-xs text-muted-foreground">
              Matched against the whole command, with <code>*</code> standing for an argument.
              Anything containing <code>;</code>, <code>|</code>, <code>&amp;</code> or a redirect
              always asks, whatever is listed here.
            </span>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save and connect once
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {hosts === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No servers saved. Until you add one, the assistant has no way to reach any machine.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {hosts.map((host) => (
            <li
              key={host.id}
              className="flex items-start justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium">{host.name}</p>
                <p className="text-muted-foreground">
                  {host.username}@{host.host}:{host.port} · {host.authKind}
                </p>
                <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  {host.fingerprint ? (
                    <>SHA256 {readable(host.fingerprint)}</>
                  ) : (
                    <span className="text-amber-600">
                      No host key pinned yet. Commands will connect without checking who answers.
                    </span>
                  )}
                </p>
                {host.autoApprove.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Runs without asking: {host.autoApprove.join(', ')}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${host.name}`}
                onClick={() => remove(host)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
