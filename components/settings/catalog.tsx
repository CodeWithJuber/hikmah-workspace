'use client';
/** Connector catalog (PR-26).
 *
 * The screen exists to make three things visible before anything is trusted:
 * what a connector wants permission to touch (shown before install, granted
 * explicitly), whether an update widens those permissions (re-grant
 * required), and whether a version was revoked (existing installs keep
 * working, new installs refused — shown honestly, not hidden).
 */
import { useEffect, useState } from 'react';
import { ArrowUpCircle, Ban, CheckCircle2, Loader2, Package, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';

type Connector = {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  status: 'active' | 'deprecated' | 'revoked';
  signatureValid: boolean;
  updateAvailable: boolean;
  latestVersion: string;
};

type Install = {
  manifestId: string;
  name: string;
  version: string;
  status: 'active' | 'deprecated' | 'revoked';
  grantedPermissions: string[];
  installedAt: string;
  signatureValid: boolean;
  updateAvailable: boolean;
  latestVersion: string;
  needsRegrant: boolean;
  permissionsAdded: string[];
};

const PERMISSION_HELP: Record<string, string> = {
  'notes:read': 'Read your workspace notes',
  'notes:write': 'Create and edit your notes',
  'files:read': 'Read files inside one allowed directory',
  'files:write': 'Write files inside one allowed directory',
  'calc:compute': 'Run calculations (no network, no file access)',
  'time:read': 'Read the clock and convert timezones (no network)',
  'net:fetch': 'Fetch pages over HTTPS',
  'kb:read': 'Read knowledge-base entries',
};

async function send(path: string, method: string, body?: object) {
  const response = await clientFetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parsed.error ?? 'That did not work.');
  return parsed;
}

function PermissionChips({ permissions }: { permissions: string[] }) {
  if (!permissions.length)
    return <span className="text-xs text-muted-foreground">No permissions requested.</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => (
        <li
          key={permission}
          title={PERMISSION_HELP[permission] ?? permission}
          className="rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[11px]"
        >
          {permission}
        </li>
      ))}
    </ul>
  );
}

export function ConnectorCatalog() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [installs, setInstalls] = useState<Install[] | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [granting, setGranting] = useState<string | null>(null);
  const [granted, setGranted] = useState<string[]>([]);
  const [regranting, setRegranting] = useState<string | null>(null);
  const [regranted, setRegranted] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const data = await send('/api/catalog', 'GET');
    setConnectors(data.connectors);
    setInstalls(data.installs);
  };

  useEffect(() => {
    let live = true;
    send('/api/catalog', 'GET')
      .then((data) => {
        if (!live) return;
        setConnectors(data.connectors);
        setInstalls(data.installs);
      })
      .catch(() => {
        if (!live) return;
        setConnectors([]);
        setInstalls([]);
      });
    clientFetch('/api/authz/me')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (live) setIsOwner(response.ok && body.role === 'owner');
      })
      .catch(() => {
        if (live) setIsOwner(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const startGrant = (connector: Connector) => {
    setGranting(connector.id);
    setGranted([...connector.permissions]);
  };

  const toggleGranted = (permission: string) =>
    setGranted((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );

  const doInstall = async (connector: Connector) => {
    setBusy(connector.id);
    try {
      await send('/api/catalog/install', 'POST', {
        name: connector.name,
        grantedPermissions: granted,
      });
      toast.success(`${connector.name} installed.`);
      setGranting(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Install failed.');
    } finally {
      setBusy(null);
    }
  };

  const doUpdate = async (install: Install, withRegrant: string[]) => {
    setBusy(install.manifestId);
    try {
      await send('/api/catalog/update', 'POST', {
        name: install.name,
        version: install.latestVersion,
        grantedPermissions: withRegrant,
      });
      toast.success(`${install.name} updated to ${install.latestVersion}.`);
      setRegranting(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Update failed.');
    } finally {
      setBusy(null);
    }
  };

  const doRevoke = async (install: Install) => {
    if (
      !window.confirm(
        `Revoke ${install.name} ${install.version}? Existing installs keep working; new installs will be refused. This cannot be undone.`,
      )
    )
      return;
    setBusy(install.manifestId);
    try {
      await send('/api/catalog/revoke', 'POST', { name: install.name, version: install.version });
      toast.success(`${install.name} ${install.version} revoked.`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Revoke failed.');
    } finally {
      setBusy(null);
    }
  };

  if (connectors === null || installs === null)
    return (
      <div className="grid gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );

  return (
    <div className="grid gap-8">
      <div className="grid gap-3">
        <h3 className="text-sm font-medium">Browse</h3>
        {connectors.length === 0 && (
          <p className="text-sm text-muted-foreground">The catalog is empty right now.</p>
        )}
        {connectors.map((connector) => {
          const installed = installs.some((i) => i.name === connector.name);
          const open = granting === connector.id;
          return (
            <div key={connector.id} className="rounded-lg border border-border p-4 grid gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <Package className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{connector.name}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px]">
                      {connector.version}
                    </span>
                    {connector.status === 'deprecated' && (
                      <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-600">
                        Deprecated
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">{connector.description}</p>
                </div>
                {!installed &&
                  (busy === connector.id ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => startGrant(connector)}>
                      Install
                    </Button>
                  ))}
                {installed && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5" aria-hidden /> Installed
                  </span>
                )}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Permissions requested
                </p>
                <PermissionChips permissions={connector.permissions} />
              </div>
              {open && (
                <div className="grid gap-2 rounded-md bg-muted/50 p-3">
                  <p className="text-xs text-muted-foreground">
                    Grant what this connector may touch. Unchecked permissions stay denied — a run
                    that needs them will be refused, not silently allowed.
                  </p>
                  {connector.permissions.map((permission) => (
                    <label
                      key={permission}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={granted.includes(permission)}
                        onChange={() => toggleGranted(permission)}
                        className="size-4 accent-current"
                      />
                      <span className="font-mono text-xs">{permission}</span>
                      <span className="text-xs text-muted-foreground">
                        {PERMISSION_HELP[permission] ?? ''}
                      </span>
                    </label>
                  ))}
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      disabled={busy === connector.id}
                      onClick={() => doInstall(connector)}
                    >
                      {busy === connector.id ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        'Confirm install'
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGranting(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">Installed</h3>
        {installs.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing installed yet.</p>
        )}
        {installs.map((install) => (
          <div key={install.manifestId} className="rounded-lg border border-border p-4 grid gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{install.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px]">
                    {install.version}
                  </span>
                  {install.status === 'revoked' && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 px-2 py-0.5 text-[11px] text-red-600">
                      <Ban className="size-3" aria-hidden /> Revoked
                    </span>
                  )}
                  {install.updateAvailable && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/40 px-2 py-0.5 text-[11px] text-blue-600">
                      <ArrowUpCircle className="size-3" aria-hidden /> Update to{' '}
                      {install.latestVersion}
                    </span>
                  )}
                </div>
                {install.status === 'revoked' && (
                  <p className="text-xs text-muted-foreground">
                    Revoked by the owner. Your install keeps working; new installs are refused.
                  </p>
                )}
              </div>
              {isOwner && install.status !== 'revoked' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === install.manifestId}
                  onClick={() => doRevoke(install)}
                  title="Revoke this version for everyone. Existing installs keep working; new installs are refused."
                >
                  <ShieldAlert className="size-3.5" aria-hidden /> Revoke
                </Button>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Granted permissions
              </p>
              <PermissionChips permissions={install.grantedPermissions} />
            </div>
            {install.updateAvailable &&
              (regranting === install.manifestId ? (
                <div className="grid gap-2 rounded-md bg-muted/50 p-3">
                  <p className="text-xs text-muted-foreground">
                    Version {install.latestVersion} requests new permissions. Check each one to
                    re-grant — the update is refused until you do.
                  </p>
                  {install.permissionsAdded.map((permission) => (
                    <label
                      key={permission}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={regranted.includes(permission)}
                        onChange={() =>
                          setRegranted((prev) =>
                            prev.includes(permission)
                              ? prev.filter((p) => p !== permission)
                              : [...prev, permission],
                          )
                        }
                        className="size-4 accent-current"
                      />
                      <span className="font-mono text-xs">{permission}</span>
                      <span className="text-xs text-muted-foreground">
                        {PERMISSION_HELP[permission] ?? ''}
                      </span>
                    </label>
                  ))}
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      disabled={busy === install.manifestId}
                      onClick={() =>
                        doUpdate(install, [...install.grantedPermissions, ...regranted])
                      }
                    >
                      {busy === install.manifestId ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        'Update with new grants'
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRegranting(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === install.manifestId}
                    onClick={() => {
                      if (install.needsRegrant) {
                        setRegranting(install.manifestId);
                        setRegranted([]);
                      } else {
                        void doUpdate(install, install.grantedPermissions);
                      }
                    }}
                  >
                    {busy === install.manifestId ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      `Update to ${install.latestVersion}`
                    )}
                  </Button>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
