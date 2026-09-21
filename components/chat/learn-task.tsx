'use client';
/** Background research, launched from the composer's Tools menu.
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
      toast('Research started. Follow it under Background tasks in your chat history.');
      setBrief('');
      onOpenChange(false);
      onStarted?.();
    } catch {
      toast.error('The task could not be started. Your brief is still here; try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="chat-learn-dialog">
        <DialogHeader>
          <DialogTitle>Start background research</DialogTitle>
          <DialogDescription>
            Research a topic in a separate conversation while you keep chatting. The report appears
            under Background tasks. Suggested memories wait for your review before use.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          dir="auto"
          aria-label="Research brief"
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
            {busy ? 'Starting…' : 'Start research'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
