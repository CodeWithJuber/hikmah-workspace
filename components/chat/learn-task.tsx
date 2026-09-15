'use client';
/** "Learn this in the background…" — the dialog behind the `+` menu entry.
 *
 * Starting a task is a POST to `/api/conversations/tasks` with the same run
 * configuration a chat turn carries, plus the brief. The task is its own
 * conversation, so the person stays in the one they were in: the list gains a
 * row under *Background tasks*, and a toast says so. Nothing here tails the
 * run — a task's output is read when they open it, not watched.
 */
import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client/request';

export function LearnTaskDialog({
  open,
  onOpenChange,
  run,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The run configuration the chat is sending, reused as the task's. */
  run: Record<string, unknown>;
  /** The task was queued: the list should refresh. */
  onStarted?: () => void;
}) {
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const text = brief.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const response = await clientFetch('/api/conversations/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...run, brief: text }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast.error(payload.error ?? 'The task could not be started.');
        return;
      }
      toast('Learning in the background. It will appear under Background tasks when it is done.');
      setBrief('');
      onOpenChange(false);
      onStarted?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="chat-learn-dialog">
        <DialogHeader>
          <DialogTitle>What should Hikmah learn?</DialogTitle>
          <DialogDescription>
            It works on its own while you carry on here, reading sources and keeping what it finds
            for your review. Nothing it keeps is used until you accept it under Memory.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          dir="auto"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="A topic, a question, or what you want it to read up on…"
          rows={5}
          maxLength={4000}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !brief.trim()} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start learning'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
