'use client';
/** Share a conversation with a link.
 *
 * The dialog asks the conversation's share state first, so reopening it shows
 * "a link is already active" instead of minting a second token by accident.
 * The link itself is created on demand and shown exactly once — the server
 * stores only its hash, so a lost link means creating a new one, not
 * recovering the old.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { clientFetch } from '@/lib/client/request';

type ShareState =
  | { kind: 'loading' }
  | { kind: 'unshared' }
  | { kind: 'created'; url: string }
  | { kind: 'shared'; createdAt: string | null };

export function ShareDialog({
  conversationId,
  conversationTitle,
  open,
  onOpenChange,
}: {
  conversationId: string | null;
  conversationTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<ShareState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The dialog is reused across conversations, so its state resets every time
  // it opens. Done during render (guarded, so it is idempotent) rather than in
  // an effect.
  const [resetFor, setResetFor] = useState<string | null>(null);
  const openFor = open ? conversationId : null;
  if (openFor !== resetFor) {
    setResetFor(openFor);
    setCopied(false);
    setState({ kind: 'loading' });
  }

  useEffect(() => {
    if (!openFor) return;
    let live = true;
    void clientFetch(`/api/conversations/${encodeURIComponent(openFor)}/share`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { shared?: boolean; createdAt?: string | null };
        if (live)
          setState(
            payload.shared
              ? { kind: 'shared', createdAt: payload.createdAt ?? null }
              : { kind: 'unshared' },
          );
      })
      .catch(() => {
        if (live) toast.error('Could not check the share status.');
      });
    return () => {
      live = false;
    };
  }, [openFor]);

  const create = useCallback(async () => {
    if (!conversationId) return;
    setBusy(true);
    try {
      const response = await clientFetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/share`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!response.ok) throw new Error('Could not create the share link.');
      const payload = (await response.json()) as { url?: string };
      if (!payload.url) throw new Error('Could not create the share link.');
      setState({ kind: 'created', url: payload.url });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the share link.');
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  const revoke = useCallback(async () => {
    if (!conversationId) return;
    setBusy(true);
    try {
      const response = await clientFetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/share`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
      );
      if (!response.ok) throw new Error('Could not revoke the share link.');
      setState({ kind: 'unshared' });
      toast.success('Share link revoked.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke the share link.');
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy the link.');
    }
  }, []);

  const url = state.kind === 'created' ? state.url : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share conversation</DialogTitle>
          <DialogDescription>
            Anyone with the link can view “{conversationTitle || 'Untitled conversation'}”. They
            cannot chat in it, and you can revoke the link at any time.
          </DialogDescription>
        </DialogHeader>

        {state.kind === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Checking…
          </div>
        ) : state.kind === 'shared' ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm">
              <Link2 size={16} className="text-emerald-600" aria-hidden="true" />A share link is
              active
              {state.createdAt
                ? ` · created ${new Date(state.createdAt).toLocaleDateString()}`
                : ''}
              .
            </p>
            <p className="text-sm text-muted-foreground">
              The link itself was shown when it was created. If you lost it, create a new one — the
              old link stops working.
            </p>
          </div>
        ) : state.kind === 'created' && url ? (
          <div className="flex items-center gap-2">
            <Input
              value={url}
              readOnly
              aria-label="Share link"
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => void copy(url)}
              aria-label="Copy share link"
            >
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This conversation is not shared. Creating a link lets anyone who has it read the
            conversation, read-only.
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {state.kind === 'shared' && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void revoke()}
              disabled={busy}
            >
              {busy ? 'Revoking…' : 'Revoke link'}
            </Button>
          )}
          {(state.kind === 'unshared' || state.kind === 'shared') && (
            <Button type="button" onClick={() => void create()} disabled={busy}>
              {busy ? 'Creating…' : state.kind === 'shared' ? 'Create new link' : 'Create link'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
