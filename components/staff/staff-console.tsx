'use client';
/** The operator console: user list, usage, tier overrides, refunds, bans, and
 * the audit trail.
 *
 * Buttons hide by permission, but the hiding is courtesy — every mutation
 * re-checks its permission on the API route, which is the actual enforcement.
 * A support staffer sees the same tables as the owner and can change nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search } from 'lucide-react';
import { toast } from 'sonner';
import { clientFetch } from '@/lib/client/request';
import type { Permission, Role } from '@/lib/authz/roles';

type StaffUser = {
  id: string;
  email: string;
  name: string | null;
  createdAt: string | number;
  tier: 'owner' | 'byok' | 'managed';
  role: Role | null;
  banned: boolean;
  usage: { tokens: number; runs: number; metered: number };
};

type AuditEntry = {
  id: string;
  actorId: string;
  action: string;
  targetUserId: string | null;
  detail: string | null;
  createdAt: string;
};

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function fmtDate(value: string | number): string {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';
}

function fmtTime(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

export function StaffConsole({ role, permissions }: { role: Role; permissions: Permission[] }) {
  const canManageUsers = permissions.includes('users:manage');
  const canBill = permissions.includes('billing:override');
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const fetchUsers = useCallback(async (): Promise<{
    users: StaffUser[];
    total: number;
  } | null> => {
    const r = await clientFetch(`/api/admin/users?limit=50&q=${encodeURIComponent(query)}`, {});
    const payload = r.ok ? await r.json() : null;
    if (!payload?.users) return null;
    return { users: payload.users, total: payload.total ?? payload.users.length };
  }, [query]);

  const fetchAudit = useCallback(async (): Promise<{
    entries: AuditEntry[];
    total: number;
  } | null> => {
    const r = await clientFetch('/api/admin/audit?limit=50', {});
    const payload = r.ok ? await r.json() : null;
    if (!payload?.entries) return null;
    return { entries: payload.entries, total: payload.total ?? payload.entries.length };
  }, []);

  /** Pure fetchers above, state applied here: the effect below and the event
   * handlers below only ever setState inside .then(), never synchronously. */
  const applyUsers = useCallback((result: { users: StaffUser[]; total: number } | null) => {
    if (result) {
      setUsers(result.users);
      setTotal(result.total);
    } else {
      toast.error('The user list could not be loaded.');
    }
    setLoading(false);
  }, []);

  const applyAudit = useCallback((result: { entries: AuditEntry[]; total: number } | null) => {
    if (result) {
      setAuditEntries(result.entries);
      setAuditTotal(result.total);
    } else {
      toast.error('The audit log could not be loaded.');
    }
  }, []);

  useEffect(() => {
    let live = true;
    // Mount: the loading spinner is already on from the initial state; the
    // fetch settles state in .then(), never synchronously in the effect body.
    void fetchUsers().then((result) => {
      if (live) applyUsers(result);
    });
    return () => {
      live = false;
    };
  }, [fetchUsers, applyUsers]);

  /** Refresh the user list with the spinner; safe from event handlers. */
  function refreshUsers() {
    setLoading(true);
    void fetchUsers().then(applyUsers);
  }

  function selectTab(t: 'users' | 'audit') {
    setTab(t);
    if (t === 'users') refreshUsers();
    else void fetchAudit().then(applyAudit);
  }

  async function mutate(id: string, email: string, body: Record<string, unknown>, what: string) {
    setBusy(id + what);
    try {
      const r = await clientFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await r.json().catch(() => null);
      if (!r.ok) {
        toast.error(payload?.error ?? `Could not ${what}.`);
        return;
      }
      const done = (payload?.changes as string[])?.join(', ') || 'no change needed';
      toast.success(`${email}: ${done}.`);
      refreshUsers();
    } catch {
      toast.error(`Could not ${what}.`);
    } finally {
      setBusy('');
    }
  }

  async function refund(id: string, email: string) {
    if (!window.confirm(`Refund ${email}'s most recent paid invoice through Stripe?`)) return;
    setBusy(id + 'refund');
    try {
      const r = await clientFetch('/api/admin/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: id }),
      });
      const payload = await r.json().catch(() => null);
      if (!r.ok) {
        toast.error(payload?.error ?? 'The refund could not be made.');
        return;
      }
      toast.success(`Refunded ${payload.amount} ${payload.currency} to ${email}.`);
      void fetchAudit().then(applyAudit);
    } catch {
      toast.error('The refund could not be made.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="staff">
      <header className="staff-head">
        <Link href="/chat" className="staff-back">
          <ArrowLeft size={16} aria-hidden />
          Back to your workspace
        </Link>
        <h1>Staff console</h1>
        <p className="staff-muted">
          Signed in as {role === 'owner' ? 'the operator' : 'support staff'}
          {role === 'support' && ' — read-only. Changes are the operator\u2019s.'} Every change
          below is written to the audit log.
        </p>
      </header>

      <div className="staff-tabs" role="tablist" aria-label="Staff console sections">
        {(['users', 'audit'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'is-active' : ''}
            onClick={() => selectTab(t)}
          >
            {t === 'users' ? `Users (${total})` : `Audit log (${auditTotal})`}
          </button>
        ))}
      </div>

      {tab === 'users' && (
        <section aria-label="Users">
          <div className="staff-search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              placeholder="Search by email\u2026"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search users by email"
            />
          </div>
          {loading ? (
            <p className="staff-muted">Loading users\u2026</p>
          ) : users.length === 0 ? (
            <p className="staff-muted">No accounts match.</p>
          ) : (
            <div className="staff-table-wrap">
              <table className="staff-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Tier</th>
                    <th>Role</th>
                    <th>Used this month</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={u.banned ? 'is-banned' : ''}>
                      <td>
                        <div className="staff-email">{u.email}</div>
                        <div className="staff-sub">
                          {u.name ?? 'No name'} · joined {fmtDate(u.createdAt)}
                        </div>
                      </td>
                      <td>
                        {u.tier === 'owner' ? (
                          <span className="staff-pill">operator</span>
                        ) : canBill ? (
                          <select
                            aria-label={`Tier for ${u.email}`}
                            value={u.tier}
                            disabled={busy !== ''}
                            onChange={(e) =>
                              window.confirm(
                                `Move ${u.email} to ${e.target.value === 'managed' ? 'Pro' : 'Free'} manually? This overrides Stripe.`,
                              ) &&
                              void mutate(
                                u.id,
                                u.email,
                                { tier: e.target.value },
                                'change the tier',
                              )
                            }
                          >
                            <option value="byok">Free</option>
                            <option value="managed">Pro</option>
                          </select>
                        ) : (
                          <span className="staff-pill">
                            {u.tier === 'managed' ? 'Pro' : 'Free'}
                          </span>
                        )}
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="staff-pill">operator</span>
                        ) : canManageUsers ? (
                          <select
                            aria-label={`Staff role for ${u.email}`}
                            value={u.role ?? ''}
                            disabled={busy !== ''}
                            onChange={(e) =>
                              void mutate(
                                u.id,
                                u.email,
                                { role: e.target.value || null },
                                e.target.value ? 'grant the support role' : 'revoke the staff role',
                              )
                            }
                          >
                            <option value="">none</option>
                            <option value="support">support</option>
                          </select>
                        ) : (
                          <span className="staff-pill">{u.role ?? '—'}</span>
                        )}
                      </td>
                      <td>
                        <div className="staff-usage">
                          {compact.format(u.usage.tokens)} tokens · {u.usage.runs} answers
                        </div>
                        {u.tier === 'managed' && (
                          <div className="staff-sub">
                            {compact.format(u.usage.metered)} on our key
                          </div>
                        )}
                      </td>
                      <td>
                        {u.banned ? (
                          <span className="staff-pill is-danger">banned</span>
                        ) : (
                          <span className="staff-pill">active</span>
                        )}
                      </td>
                      <td>
                        <div className="staff-actions">
                          {canManageUsers && u.role !== 'owner' && (
                            <button
                              type="button"
                              disabled={busy !== ''}
                              onClick={() =>
                                window.confirm(
                                  u.banned
                                    ? `Unban ${u.email}? They will be able to sign in again.`
                                    : `Ban ${u.email}? They will be signed out of the product immediately.`,
                                ) &&
                                void mutate(
                                  u.id,
                                  u.email,
                                  { banned: !u.banned },
                                  u.banned ? 'unban' : 'ban',
                                )
                              }
                            >
                              {busy === u.id + (u.banned ? 'unban' : 'ban')
                                ? 'Working\u2026'
                                : u.banned
                                  ? 'Unban'
                                  : 'Ban'}
                            </button>
                          )}
                          {canBill && u.tier !== 'owner' && (
                            <button
                              type="button"
                              disabled={busy !== ''}
                              onClick={() => void refund(u.id, u.email)}
                            >
                              {busy === u.id + 'refund' ? 'Working\u2026' : 'Refund last'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'audit' && (
        <section aria-label="Audit log">
          {auditEntries.length === 0 ? (
            <p className="staff-muted">No admin actions recorded yet.</p>
          ) : (
            <div className="staff-table-wrap">
              <table className="staff-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((e) => (
                    <tr key={e.id}>
                      <td className="staff-sub">{fmtTime(e.createdAt)}</td>
                      <td>
                        <span className="staff-pill">{e.action}</span>
                      </td>
                      <td className="staff-sub">{e.targetUserId ?? '—'}</td>
                      <td className="staff-sub">{e.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
